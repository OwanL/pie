/**
 * ProxyService — spawns and supervises the local LiteLLM proxy.
 *
 * The proxy (pie/proxy/, an isolated `uv run litellm` Python process) fronts
 * the API-key providers configured in settings.json `proxy.providers` so
 * per-provider concurrency limits can be enforced centrally. See
 * docs/AGENT-HARNESS-IMPROVEMENTS.md §1–§3 and proxy/README.md.
 *
 * Lifecycle mirrors `BackendClient`: reclaim any existing holder on the target
 * port, spawn a fresh process, wait for a readiness signal, then resolve /
 * reject. The readiness signal is an HTTP 200 from
 * `/health/liveness` instead of a JSON-RPC `backend.ready` event. On failure
 * the caller (startup.ts) dispatches a `NoticeShown` and DOES NOT start the
 * backend — "fail loud" by design (no silent fallback to direct routing).
 *
 * Providers without a `proxy.providers` entry (e.g. GitHub Copilot, Ollama)
 * stay direct; only the providers whose `baseUrl` in models.json points at
 * 127.0.0.1:proxyPort use this. The proxy's `master_key` in litellm_config.yaml
 * (set to `os.environ/PIE_PROXY_MASTER_KEY`) is a pie-managed localhost gate the
 * backend sends as the proxied-provider `apiKey` (`$PIE_PROXY_MASTER_KEY` in
 * models.json) — it is not a cloud secret and is decoupled from each provider's
 * upstream key (which litellm sends via `api_key: os.environ/<apiKeyEnv>`).
 * DB-less LiteLLM requires the Authorization to match `master_key`.
 */

import * as cp from 'node:child_process';
import * as http from 'node:http';
import type * as vscode from 'vscode';

import { appendPieLog, bootLog } from '../util/audit';
import { toErrorMessage } from '../util/error-message';

/** Default readiness timeout for the proxy's `/health/liveness` to answer 200. */
const PROXY_READY_TIMEOUT_MS = 60_000; // generous — first `uv run` resolves deps
const HEALTH_POLL_INTERVAL_MS = 500;

/** Bug: reused-proxy health monitor. A proxy reused via the fast path
 *  (this.proc stays undefined) is NOT tracked by ProxyService, so a mid-session
 *  hang (uvicorn event loop wedged by a stalled upstream before headers) is
 *  invisible — the backend keeps pointing at a dead port and every proxied
 *  turn fails with an opaque "Connection error.". The monitor probes
 *  /health/liveness on an interval; after N consecutive failures it reclaims
 *  the port and (when start options are known) respawns a fresh tracked child.
 *  Env-tunable so a tight test can shrink the window.
 *
 *  A busy-but-alive proxy (parallel subagent streaming saturating the single
 *  uvicorn worker + the shared max_parallel_requests:2 semaphore) can be SLOW
 *  to answer /health/liveness without being dead. Killing it on a transient
 *  slow-probe disrupts every in-flight stream (the disruptive popup). So the
 *  monitor distinguishes REFUSED (the process is gone — dead) from TIMEOUT
 *  (the process is alive but event-loop-starved — busy). Both eventually
 *  recover, but TIMEOUT needs a much higher threshold so a sustained busy
 *  window under load does NOT cascade into a self-inflicted restart storm. */
const PROXY_HEALTH_MONITOR_ENV = 'PIE_PROXY_HEALTH_MONITOR_MS';
const DEFAULT_PROXY_HEALTH_MONITOR_MS = 30_000; // every 30s
const PROXY_HEALTH_FAIL_THRESHOLD = 3; // 3 consecutive REFUSED ≈ 90s dead
const PROXY_HEALTH_SLOW_THRESHOLD = 6; // 6 consecutive TIMEOUT ≈ 3min starved
const PROXY_HEALTH_PROBE_TIMEOUT_MS = 10_000; // generous for a busy event loop

function resolveHealthMonitorIntervalMs(): number {
  const raw = process.env[PROXY_HEALTH_MONITOR_ENV];
  if (raw === undefined || raw === '') return DEFAULT_PROXY_HEALTH_MONITOR_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_PROXY_HEALTH_MONITOR_MS;
}

export interface ProxyStartOptions {
  proxyDir: string;
  configPath: string;
  port: number;
  host: string;
}

export interface ProxyReadyPayload {
  port: number;
  baseUrl: string;
  pid: number;
}

/** Bug 5 structured-notice payload: fired by {@link ProxyService.stop} when a
 *  tracked proxy child is about to be killed (the first half of a config
 *  restart). An in-flight proxied stream routed through the dying proxy will
 *  get an opaque ECONNRESET/socket-hang-up; without this notice the user
 *  cannot tell "proxy restarted under me" vs "provider cut" vs "proxy
 *  throttled". The caller (session-service) wires this to a `NoticeShown`. */
export interface ProxyInFlightInterruptedPayload {
  code: 'PROXY_RESTART_IN_FLIGHT';
  message: string;
  pid: number;
  /** Why the proxy is being stopped, so the caller can log/surface an accurate
   *  message instead of the stale hard-coded "config changed". */
  reason: ProxyStopReason;
}

/** Why {@link ProxyService.stop} is tearing down the tracked proxy child.
 *  Determines the user-facing message so a health-monitor recovery (the proxy
 *  became unresponsive under parallel load) is NOT mislabeled as a config edit. */
export type ProxyStopReason = 'config' | 'health-monitor' | 'dispose';

/** User-facing messages per stop reason. All mention "proxy" + "restart" so the
 *  existing test regex (`/proxy.*restart|restart.*proxy/i`) holds, while the
 *  cause is accurate. */
const PROXY_STOP_REASON_MESSAGES: Record<ProxyStopReason, string> = {
  config: 'The pie proxy is restarting (config changed). An in-flight proxied turn may have been interrupted.',
  'health-monitor': 'The pie proxy became unresponsive and is restarting. An in-flight proxied turn may have been interrupted.',
  dispose: 'The pie proxy is stopping. An in-flight proxied turn may have been interrupted.',
};

/** Resolve the `uv` binary, probing common install + PATH locations. */
function resolveUv(): string {
  // Delegate to the same logic the scripts/proxy.mjs control script uses.
  // For simplicity here we trust PATH (the extension host inherits the User
  // env var scope after a full VS Code restart; the installer already ensures
  // `uv` is on PATH). If the spawn fails, `start()` rejects with a clear
  // message pointing at the prerequisites.
  return 'uv';
}

/** Transient env for the litellm subprocess: UTF-8 IO so its Unicode banner
 *  doesn't crash on Windows cp1252 when stderr is piped (see proxy.mjs). */
function spawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };
}

export class ProxyService implements vscode.Disposable {
  private proc?: cp.ChildProcess;
  private stderrBuffer = '';
  private readonly stderrLimit = 32 * 1024;
  /** Bug: reused-proxy health monitor. Set when start() reuses a healthy proxy
   *  via the fast path (this.proc stays undefined). Probes /health/liveness on
   *  an interval; after N consecutive misses, reclaims the port + respawns a
   *  fresh tracked child so the backend isn't left pointing at a dead port.
   *  Cleared by stop()/dispose()/restart(). */
  private healthMonitor?: ReturnType<typeof setInterval>;
  private healthFailures = 0;
  /** Consecutive TIMEOUT probes (busy-but-alive). Tracked separately from
   *  `healthFailures` (REFUSED = dead) so a sustained parallel-load window
   *  needs many more slow-probes before the monitor kills an alive proxy. */
  private healthSlowFailures = 0;
  /** Cached start options so the monitor can respawn a fresh tracked child after
   *  reclaiming a hung reused proxy. */
  private lastStartOptions?: ProxyStartOptions;
  /** Optional callback invoked when the monitor detects a hung reused proxy
   *  and reclaims + respawns it — so session-service can surface a NoticeShown. */
  onProxyHungReclaimed?: (payload: { port: number; reason: string }) => void;

  /** Bug 5 observability hook: invoked synchronously from {@link stop} BEFORE
   *  the kill, when a tracked child is about to be torn down. The caller
   *  (session-service) dispatches a `NoticeShown` so an in-flight proxied
   *  stream that is about to die with an opaque ECONNRESET is attributable to
   *  "proxy restarted" instead of looking like a provider cut. Intentionally
   *  NOT a drain: pie does not track per-session routing through the proxy,
   *  so a real drain is out of scope for the minimal-diff hardening — the
   *  notice is the loud, structured fix. */
  onInFlightInterrupted?: (payload: ProxyInFlightInterruptedPayload) => void;

  /** Spawn the pie proxy wrapper (LiteLLM + metrics route) and resolve once `/health/liveness` returns 200. */
  async start(options: ProxyStartOptions): Promise<ProxyReadyPayload> {
    if (this.proc) {
      throw new Error('Proxy is already running');
    }

    const { configPath, proxyDir, port, host } = options;
    const baseUrl = `http://${host}:${port}`;

    // Always start fresh on app startup/restart. Reclaim any existing holder
    // first (including an otherwise-healthy prior-run proxy) so config/env and
    // process state cannot leak across restarts. Also prevents uvicorn from
    // silently falling back to an EPHEMERAL port when the configured one is
    // already bound.
    await this.reclaimOrphanedPort(port, host);

    this.lastStartOptions = options;
    bootLog('proxy-service', 'start.spawn', { uv: resolveUv(), proxyDir, port });

    const proc = cp.spawn(
      resolveUv(),
      ['run', 'python', 'pie_proxy.py', '--config', configPath, '--port', String(port), '--host', host],
      {
        cwd: proxyDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv(),
        shell: false,
        windowsHide: true,
        // detached so we can signal the whole process group on stop (Unix).
        // On Windows the group kill is done via `taskkill /T` instead, so
        // detached is harmless there.
        detached: process.platform !== 'win32',
      },
    );
    this.proc = proc;

    if (proc.stderr) {
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk: string) => {
        this.stderrBuffer += chunk;
        if (this.stderrBuffer.length > this.stderrLimit) {
          this.stderrBuffer = this.stderrBuffer.slice(-this.stderrLimit);
        }
      });
    }

    const ready = await new Promise<ProxyReadyPayload>((resolve, reject) => {
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        exitDisposable.dispose();
        errorDisposable.dispose();
        fn();
      };

      const exitListener = (code: number | null) => {
        settle(() =>
          reject(
            new Error(
              `LiteLLM proxy exited before becoming ready${
                code === null ? '' : ` (code ${code})`
              }${this.stderrBuffer.trim() ? `: ${this.stderrBuffer.trim().slice(-800)}` : ''}`,
            ),
          ),
        );
      };
      proc.once('exit', exitListener);
      const exitDisposable = { dispose: () => proc.off('exit', exitListener) };

      const errorListener = (err: Error) => {
        this.proc = undefined;
        settle(() =>
          reject(
            new Error(
              `Failed to spawn LiteLLM proxy via 'uv run python pie_proxy.py' in ${proxyDir}. ` +
                `Ensure 'uv' is installed and on PATH (see pie/proxy/README.md prerequisites). ${err.message}`,
            ),
          ),
        );
      };
      proc.once('error', errorListener);
      const errorDisposable = { dispose: () => proc.off('error', errorListener) };

      const timeout = setTimeout(() => {
        settle(() => {
          this.stop();
          reject(
            new Error(
              `LiteLLM proxy did not become ready within ${PROXY_READY_TIMEOUT_MS / 1000}s at ${baseUrl}. ` +
                `Check pie/proxy/ is intact and 'uv' can resolve litellm[proxy]. ` +
                (this.stderrBuffer.trim() ? `stderr tail: ${this.stderrBuffer.trim().slice(-800)}` : ''),
            ),
          );
        });
      }, PROXY_READY_TIMEOUT_MS);

      // Poll /health/liveness. litellm binds the port once asyncio is up;
      // a refused connection means "not ready yet", not "broken".
      const poll = async () => {
        while (!settled) {
          const up = await this.healthCheck(baseUrl, 1500);
          if (up) {
            settle(() =>
              resolve({ port, baseUrl, pid: proc.pid ?? 0 }),
            );
            return;
          }
          await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
        }
      };
      void poll().catch((err) =>
        settle(() =>
          reject(
            new Error(`Proxy health poll failed unexpectedly: ${toErrorMessage(err)}`),
          ),
        ),
      );
    });
    // Bug: a SPAWNED (tracked) proxy can wedge while staying alive — the
    // uvicorn worker's event loop blocks (slow upstream holding the GIL via
    // a sync code path), the listen backlog exhausts and the OS RSTs new
    // SYNs, or all max_parallel_requests semaphore slots leak via the
    // stream-liveness middleware's shielded-reap. The `exit` listener never
    // fires for a wedged-but-alive child, so without a health monitor the
    // proxy stays wedged indefinitely and EVERY proxied turn (including the
    // skill-pruner prepass) fails with an opaque "Connection error." until a
    // manual window reload. Arm the monitor here so the spawned path is
    // supervised too — previously it was only armed for the reused fast-path.
    this.armHealthMonitor(baseUrl);
    return ready;
  }

  /** GET /health/liveness → true on 200. Quiet — never throws. Used by the
   *  readiness poll (which treats any non-200 as "not ready yet"). */
  private healthCheck(baseUrl: string, timeoutMs: number): Promise<boolean> {
    return this.probeLiveness(baseUrl, timeoutMs).then((r) => r === 'healthy');
  }

  /** Tri-state liveness probe. Distinguishes REFUSED (the process is gone —
   *  dead) from TIMEOUT (the process is alive but event-loop-starved under
   *  parallel load — busy). The monitor treats these with different thresholds
   *  so a sustained busy window does NOT kill an alive proxy mid-stream. */
  private probeLiveness(baseUrl: string, timeoutMs: number): Promise<'healthy' | 'refused' | 'timeout'> {
    return new Promise((resolve) => {
      const req = http.get(`${baseUrl}/health/liveness`, { timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode === 200 ? 'healthy' : 'refused');
      });
      req.on('error', (err) => {
        // ECONNREFUSED/ECONNRESET → the port isn't accepting (process gone or
        // wedged socket). Anything else (incl. DNS) → treat as refused too.
        const code = (err as NodeJS.ErrnoException).code;
        resolve(code === 'ETIMEDOUT' ? 'timeout' : 'refused');
      });
      req.on('timeout', () => {
        req.destroy();
        resolve('timeout');
      });
    });
  }

  /**
   * If something is already listening on `port` and we have no tracked child
   * for it, it is an orphaned litellm from a prior run — kill its tree and
   * wait for the socket to release. Without this, uvicorn silently binds an
   * ephemeral port and pi's configured baseUrl (localhost:4000) points at a
   * port nothing is listening on — the dominant "session randomly stops"
   * failure when the proxy is in use. Mirrors scripts/proxy.mjs.
   *
   * Quiet-ish: logs to bootLog only. If we truly cannot free the port, we
   * leave it to start()'s existing health-check timeout to fail loud.
   */
  private async reclaimOrphanedPort(port: number, _host: string): Promise<void> {
    if (!this.isPortListening(port)) return;
    const holders = this.portHolderPids(port);
    if (holders.length === 0) {
      // Race: port freed between probe and lookup. Retry once.
      if (this.isPortListening(port)) {
        bootLog('proxy-service', 'port.reclaim', { port, note: 'in use but no holder PID found; leaving to startup timeout' });
      }
      return;
    }
    bootLog('proxy-service', 'port.reclaim', { port, holders, reason: 'orphaned litellm; no tracked child' });
    for (const hp of holders) this.killTree(hp);
    for (let i = 0; i < 20; i++) {
      if (!this.isPortListening(port)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    bootLog('proxy-service', 'port.reclaim.failed', { port, holders });
  }

  /** Is anything LISTENing on `port`? Best-effort TCP probe. */
  private isPortListening(port: number): boolean {
    if (process.platform === 'win32') {
      const r = cp.spawnSync('powershell', ['-NoProfile', '-Command',
        `[bool](Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue)`],
      { windowsHide: true, encoding: 'utf8' });
      return (r.stdout || '').trim() === 'True';
    }
    const r = cp.spawnSync('sh', ['-c', `nc -z 127.0.0.1 ${port} 2>/dev/null && echo yes`], { encoding: 'utf8' });
    return (r.stdout || '').includes('yes');
  }

  /** PIDs of processes LISTENing on `port` (for orphan reclaim). */
  private portHolderPids(port: number): number[] {
    if (process.platform === 'win32') {
      const r = cp.spawnSync('powershell', ['-NoProfile', '-Command',
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique`],
      { windowsHide: true, encoding: 'utf8' });
      return (r.stdout || '').split(/\s+/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    }
    const r = cp.spawnSync('sh', ['-c', `lsof -ti:${port} -sTCP:LISTEN 2>/dev/null`], { encoding: 'utf8' });
    return (r.stdout || '').split(/\s+/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  }

  /** Kill a process and its whole tree. Standalone (not tied to `this.proc`). */
  private killTree(pid: number): void {
    if (process.platform === 'win32') {
      cp.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { /* group may not exist */ }
    }
  }

  /** Force a fresh proxy spawn so a newly-regenerated `litellm_config.yaml` is
   *  loaded. LiteLLM has no `/reload` endpoint, so a config change requires a
   *  full stop+start. Also reclaims any orphaned litellm still bound to the
   *  port from a prior run — otherwise `start()`'s fast-path would reuse the
   *  stale-config proxy and never pick up the new config. */
  async restart(options: ProxyStartOptions): Promise<ProxyReadyPayload> {
    const { port, host } = options;
    await this.stop('config');
    // Kill any port holder we didn't spawn (a reused proxy from a prior run),
    // otherwise start() would reuse the stale-config proxy and never load the
    // new config.
    if (this.isPortListening(port)) {
      await this.reclaimOrphanedPort(port, host);
    }
    return this.start(options);
  }

  /** Stop the proxy child process. Safe to call repeatedly.
   *
   *  `uv run litellm` spawns litellm as a CHILD of uv — so killing only the
   *  `proc` (uv) orphans the Python litellm server still bound to proxyPort.
   *  We kill the whole tree: `taskkill /T /F` on Windows, process-group signal
   *  on Unix (the spawn below uses detached:true so PID is a group leader). */
  /** Bug: arm a background health monitor for a reused (untracked) proxy. Probes
   *  /health/liveness on an interval; after N consecutive misses, reclaims the
   *  port + respawns a fresh tracked child. No-op if a monitor is already armed. */
  private armHealthMonitor(baseUrl: string): void {
    if (this.healthMonitor) return;
    this.healthFailures = 0;
    this.healthSlowFailures = 0;
    const interval = resolveHealthMonitorIntervalMs();
    this.healthMonitor = setInterval(async () => {
      const result = await this.probeLiveness(baseUrl, PROXY_HEALTH_PROBE_TIMEOUT_MS);
      if (result === 'healthy') {
        this.healthFailures = 0;
        this.healthSlowFailures = 0;
        return;
      }
      // Separate the two hang classes so a BUSY proxy (TIMEOUT — alive but
      // event-loop-starved under parallel streaming) is NOT killed as
      // aggressively as a DEAD one (REFUSED — process gone).
      if (result === 'timeout') {
        this.healthSlowFailures += 1;
        // A transient slow probe under load is common; only reclaim after a
        // SUSTAINED starvation window (PROXY_HEALTH_SLOW_THRESHOLD × interval).
        if (this.healthSlowFailures < PROXY_HEALTH_SLOW_THRESHOLD) return;
      } else {
        this.healthFailures += 1;
        this.healthSlowFailures = 0;
        if (this.healthFailures < PROXY_HEALTH_FAIL_THRESHOLD) return;
      }
      // The proxy has hung (N consecutive misses of the relevant class) —
      // covers BOTH the reused fast-path (this.proc undefined) AND a SPAWNED
      // tracked child that wedged while alive. Reclaim the port + respawn a
      // fresh tracked child.
      //
      // Double-log: bootLog (boot-trace JSONL, gated on PI_BOOT_LOG) AND
      // appendPieLog (always-on, writes pie.log). Without appendPieLog the
      // recovery is INVISIBLE in the default config — the only visible
      // symptom was the popup from stop()→onInFlightInterrupted, which made
      // the restart look like a config edit ("config changed") instead of a
      // health-monitor reclaim. See pie-proxy-health-monitor-false-restart.md.
      const hungPayload = { port: this.lastStartOptions?.port, failures: this.healthFailures, slowFailures: this.healthSlowFailures, hangClass: result };
      bootLog('proxy-service', 'health-monitor.hung', hungPayload);
      appendPieLog('warn', 'health-monitor', 'health monitor: proxy hung — reclaiming + respawning', hungPayload);
      this.disarmHealthMonitor();
      const opts = this.lastStartOptions;
      if (opts) {
        // Stop the tracked child FIRST. A SPAWNED proxy that wedged still has
        // this.proc set, and the respawn's start() would throw "Proxy is
        // already running" + leave the wedged child on the port without this.
        // stop() also taskkill /T /F the wedged uvicorn so the port releases.
        // No-op when this.proc is undefined (reused-path hang).
        // Pass reason 'health-monitor' so the in-flight notice says "became
        // unresponsive", NOT the misleading "config changed".
        try { await this.stop('health-monitor'); } catch { /* best-effort */ }
        try { await this.reclaimOrphanedPort(opts.port, opts.host); } catch { /* best-effort */ }
        try {
          this.onProxyHungReclaimed?.({ port: opts.port, reason: 'proxy hung — health monitor reclaimed + respawned' });
        } catch { /* listener must not block recovery */ }
        try {
          // Respawn a fresh tracked child. This sets this.proc + re-establishes
          // readiness so subsequent proxied turns hit a live proxy.
          await this.start(opts);
        } catch (err) {
          bootLog('proxy-service', 'health-monitor.respawn.failed', { port: opts.port, error: toErrorMessage(err) });
          appendPieLog('error', 'health-monitor', 'health monitor: respawn failed after reclaim', { port: opts.port, error: toErrorMessage(err) });
        }
      }
    }, interval);
    // Don't keep the event loop alive for the monitor.
    this.healthMonitor.unref?.();
  }

  private disarmHealthMonitor(): void {
    if (this.healthMonitor) {
      clearInterval(this.healthMonitor);
      this.healthMonitor = undefined;
    }
    this.healthFailures = 0;
    this.healthSlowFailures = 0;
  }

  async stop(reason: ProxyStopReason = 'config'): Promise<void> {
    // Bug: clear the reused-proxy health monitor so a stop/restart doesn't
    // race the monitor's reclaim+respawn.
    this.disarmHealthMonitor();
    const proc = this.proc;
    if (!proc) return;
    this.proc = undefined;
    const pid = proc.pid;

    // Bug 5 observability: notify BEFORE the kill so an in-flight proxied
    // stream that is about to die with an opaque ECONNRESET is attributable to
    // "proxy restarted" instead of looking like a provider cut. We do NOT
    // drain (pie does not track per-session routing through the proxy); the
    // notice is the loud, structured fix and the kill is unchanged.
    //
    // The message is chosen from `reason` so a health-monitor recovery (the
    // proxy became unresponsive, NOT a config edit) is NOT mislabeled as
    // "config changed" — the most common false alarm under parallel subagent
    // load, where a busy single-worker uvicorn stalls the /health/liveness
    // probe and the monitor reclaims+respawns a proxy that was merely slow.
    if (typeof pid === 'number' && this.onInFlightInterrupted) {
      try {
        this.onInFlightInterrupted({
          code: 'PROXY_RESTART_IN_FLIGHT',
          message: PROXY_STOP_REASON_MESSAGES[reason],
          pid,
          reason,
        });
      } catch {
        /* a buggy listener must not block the kill */
      }
    }

    try {
      if (typeof pid === 'number') {
        if (process.platform === 'win32') {
          // /T = kill the whole tree rooted at pid; /F = force.
          cp.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        } else {
          try { process.kill(-pid, 'SIGTERM'); } catch { /* group may not exist */ }
        }
      }
      proc.kill(); // belt-and-suspenders on the uv parent itself
    } catch {
      /* already gone */
    }
  }

  dispose(): void {
    void this.stop('dispose');
  }
}
