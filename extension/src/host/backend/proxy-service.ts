/**
 * ProxyService — spawns and supervises the local LiteLLM proxy.
 *
 * The proxy (pie/proxy/, an isolated `uv run litellm` Python process) fronts
 * the API-key providers (umans + future) so per-provider concurrency limits
 * can be enforced centrally — the missing throughput governor for umans'
 * "4 concurrent active sessions" account limit. See
 * docs/AGENT-HARNESS-IMPROVEMENTS.md §1–§3 and proxy/README.md.
 *
 * Lifecycle mirrors `BackendClient`: spawn → wait for a readiness signal →
 * resolve / reject. The readiness signal is an HTTP 200 from
 * `/health/liveness` instead of a JSON-RPC `backend.ready` event. On failure
 * the caller (startup.ts) dispatches a `NoticeShown` and DOES NOT start the
 * backend — "fail loud" by design (no silent fallback to direct umans).
 *
 * GitHub Copilot and Ollama stay direct (not routed through here); only the
 * providers whose `baseUrl` in models.json points at 127.0.0.1:proxyPort use
 * this. The proxy's `master_key` in litellm_config.yaml (set to
 * `os.environ/UMANS_API_KEY`) is the localhost gate the backend sends as the
 * provider `apiKey` (`$UMANS_API_KEY` in models.json) — it is not a cloud
 * secret. DB-less LiteLLM requires the Authorization to match `master_key`.
 */

import * as cp from 'node:child_process';
import * as http from 'node:http';
import type * as vscode from 'vscode';

import { bootLog } from '../util/audit';
import { toErrorMessage } from '../util/error-message';

/** Default readiness timeout for the proxy's `/health/liveness` to answer 200. */
const PROXY_READY_TIMEOUT_MS = 60_000; // generous — first `uv run` resolves deps
const HEALTH_POLL_INTERVAL_MS = 500;

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

  /** Spawn uv run litellm and resolve once `/health/liveness` returns 200. */
  async start(options: ProxyStartOptions): Promise<ProxyReadyPayload> {
    if (this.proc) {
      throw new Error('Proxy is already running');
    }

    const { configPath, proxyDir, port, host } = options;
    const baseUrl = `http://${host}:${port}`;

    // Fast path: a healthy litellm from a prior run may already be bound to
    // `port`. Reuse it instead of killing + respawning an identical process.
    // The /health/liveness 200 confirms a litellm is up (the path is litellm-
    // specific, so a stray non-litellm holder won't satisfy it), and the probe
    // is a plain HTTP GET — connection-refused returns in ~1ms, so the common
    // "nothing on the port" case pays no spawnSync cost at all. We do NOT
    // track the reused child (this.proc stays undefined), so dispose()/stop()
    // leaves it running — correct, since we didn't spawn it and it may belong
    // to another window.
    //
    // Limitation: if UMANS_API_KEY changed since the holder was started, its
    // master_key is stale and umans will 401. This is a rare edge case (key
    // rotation between VS Code launches) traded for ~4.5s saved per boot; the
    // user can recover by killing the port holder or changing pie.proxyPort.
    if (await this.healthCheck(baseUrl, 1500)) {
      bootLog('proxy-service', 'start.reused', { port });
      return { port, baseUrl, pid: 0 };
    }

    // No healthy proxy on the port. Guard against an orphaned litellm from a
    // prior session still bound to `port` — without this, uvicorn silently
    // falls back to an EPHEMERAL port (e.g. 25962) and the pidfile/baseURL pi
    // is configured for points at a port nothing is listening on — random
    // "session stopped" failures with no error. The holder with no tracked
    // child is orphaned by definition, so auto-reclaim it. Mirrors
    // scripts/proxy.mjs startBackground().
    await this.reclaimOrphanedPort(port, host);

    bootLog('proxy-service', 'start.spawn', { uv: resolveUv(), proxyDir, port });

    const proc = cp.spawn(
      resolveUv(),
      ['run', 'litellm', '--config', configPath, '--port', String(port), '--host', host],
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

    return new Promise<ProxyReadyPayload>((resolve, reject) => {
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
              `Failed to spawn LiteLLM proxy via 'uv run litellm' in ${proxyDir}. ` +
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
  }

  /** GET /health/liveness → true on 200. Quiet — never throws. */
  private healthCheck(baseUrl: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`${baseUrl}/health/liveness`, { timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
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
    await this.stop();
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
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = undefined;
    const pid = proc.pid;
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
    void this.stop();
  }
}
