#!/usr/bin/env node
/**
 * pie LLM proxy control — wraps `uv run litellm` for the API-key providers
 * (umans + future) that pie routes through LiteLLM for concurrency limiting.
 *
 * Commands:
 *   run     foreground (blocks; Ctrl+C to stop)        — `npm run proxy`
 *   start   background, logs to data/proxy/proxy.log    — `npm run proxy:bg`
 *   stop    kill the background instance                — `npm run proxy:down`
 *   health  check liveness (exit 0 = up)               — `npm run proxy:health`
 *
 * See proxy/README.md for why Copilot/Ollama stay direct and for the
 * extension-host spawn path (this script is the CLI/UX mirror of that).
 */
import { spawn, spawnSync } from 'node:child_process';import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const proxyDir = path.join(repoRoot, 'proxy');
const configPath = path.join(proxyDir, 'litellm_config.yaml');
const PORT = Number(process.env.PIE_PROXY_PORT ?? 4000);
const HOST = '127.0.0.1';
const baseUrl = `http://${HOST}:${PORT}`;

// The PIDfile lets `stop` target the right process and makes `start` idempotent.
// Lives under data/proxy/ (gitignored) so it survives across shells but not a
// machine wipe — same convention as pie's session data.
const pidDir = path.join(repoRoot, 'data', 'proxy');
const pidFile = path.join(pidDir, 'proxy.pid');
const logFile = path.join(pidDir, 'proxy.log');

function log(msg) { console.error(`[pie-proxy] ${msg}`); }

/**
 * Process env with Python forced to UTF-8 IO.
 *
 * LiteLLM's startup banner contains non-ASCII characters. When stdout is
 * redirected to a file (as `start` does), Python on Windows defaults to the
 * cp1252 console codepage and the banner write raises
 * `UnicodeEncodeError: 'charmap' codec can't encode characters...`, crashing
 * startup *after* config parse. PYTHONIOENCODING + PYTHONUTF8 force UTF-8 so
 * the redirected stream accepts the banner. (Linux/macOS are already UTF-8.)
 */
function utf8Env() {
  return {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };
}

function ensureDirs() {
  fs.mkdirSync(pidDir, { recursive: true });
}

/** Resolve the uv binary, probing the common install locations on Windows. */
function resolveUv() {
  const PATH = process.env.PATH ?? '';
  const ext = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  const probe = (dir, name) => {
    for (const e of ext) {
      const p = path.join(dir, name + e);
      try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    }
    return null;
  };
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    const found = probe(dir, 'uv');
    if (found) return found;
  }
  // Proto-managed shim location (see repo memory: proto may resolve here).
  if (process.platform === 'win32') {
    const home = process.env.USERPROFILE ?? '';
    if (home) {
      const proto = probe(path.join(home, '.proto', 'bin'), 'uv');
      if (proto) return proto;
    }
  }
  return 'uv'; // last resort: let the OS resolve it (may fail)
}

/** Spawn uv run litellm (foreground). Inherits stdio so Ctrl+C propagates. */
function runForeground() {
  const uv = resolveUv();
  log(`starting litellm (foreground) via ${uv} on ${baseUrl}`);
  const child = spawn(uv, ['run', 'litellm', '--config', configPath, '--port', String(PORT), '--host', HOST], {
    cwd: proxyDir,
    stdio: 'inherit',
    windowsHide: false,
    env: utf8Env(),
  });
  child.on('error', (err) => {
    log(`failed to spawn uv: ${err.message}`);
    log('is uv installed? see proxy/README.md prerequisites');
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 128 + 1 : 1));
  });
}

/** Spawn uv run litellm detached, write PID + redirect logs. Idempotent. */
async function startBackground() {
  ensureDirs();
  if (isRunning(readPid())) {
    log(`already running (pid ${readPid()}) at ${baseUrl}`);
    return;
  }
  // Guard against an orphaned litellm from a prior run still bound to PORT.
  // If something is already listening AND no pidfile is active, the holder is
  // by definition orphaned relative to this script — auto-reclaim instead of
  // forcing manual recovery (the previous `process.exit(1)` left the orphan
  // running and is exactly how stale pythons accumulated on :4000). We still
  // fail loud rather than silently fall back to an ephemeral port, which would
  // leave a proxy nobody can reach.
  if (portInUse(PORT)) {
    const holderPids = holderPidsOnPort(PORT);
    if (holderPids.length === 0) {
      // Race: port freed between probe and lookup. Retry once.
      if (portInUse(PORT)) {
        log(`ERROR: port ${PORT} is in use but no listening process could be identified.`);
        process.exit(1);
      }
    } else {
      log(`port ${PORT} is in use by pid(s) ${holderPids.join(', ')} but no pidfile is active — reclaiming.`);
      for (const hp of holderPids) killTree(hp);
      // Wait briefly for the socket to leave TIME_WAIT / be released.
      let freed = false;
      for (let i = 0; i < 20; i++) {
        if (!portInUse(PORT)) { freed = true; break; }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!freed) {
        log(`ERROR: failed to free port ${PORT} after killing pid(s) ${holderPids.join(', ')}.`);
        process.exit(1);
      }
      log(`port ${PORT} reclaimed.`);
    }
  }
  const uv = resolveUv();
  log(`starting litellm (background) via ${uv} on ${baseUrl}; logs → ${logFile}`);
  const out = fs.openSync(logFile, 'a');
  const child = spawn(uv, ['run', 'litellm', '--config', configPath, '--port', String(PORT), '--host', HOST], {
    cwd: proxyDir,
    stdio: ['ignore', out, out],
    detached: true,
    windowsHide: true,
    env: utf8Env(),
  });
  child.on('error', (err) => {
    log(`failed to spawn uv: ${err.message}`);
    process.exit(1);
  });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
  // Give it a moment, then report readiness if the port answers.
  setTimeout(() => {
    healthCheck(false).then((up) => {
      if (up) log(`up (pid ${child.pid}) at ${baseUrl}`);
      else log(`started (pid ${child.pid}) but health-check pending — see ${logFile}`);
    });
  }, 1500);
}

function readPid() {
  try { return Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch { return null; }
}

function isRunning(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Quick TCP probe: is anything listening on `port`? Used to fail loud on
 *  orphaned litellm processes that survived a botched stop. */
function portInUse(port) {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `[bool](Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue)`],
      { windowsHide: true, encoding: 'utf8' });
    return (r.stdout || '').trim() === 'True';
  }
  // Unix: `nc -z` if available, else assume free (let uvicorn complain).
  const r = spawnSync('sh', ['-c', `nc -z 127.0.0.1 ${port} 2>/dev/null && echo yes`], { encoding: 'utf8' });
  return (r.stdout || '').includes('yes');
}

/** Return the PIDs of processes LISTENing on `port`. Used by startBackground
 *  to auto-reclaim orphans (a holder with no pidfile is orphaned by
 *  definition). Empty array on Windows/Unix probe failure. */
function holderPidsOnPort(port) {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique`],
      { windowsHide: true, encoding: 'utf8' });
    return (r.stdout || '').split(/\s+/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  }
  const r = spawnSync('sh', ['-c', `lsof -ti:${port} -sTCP:LISTEN 2>/dev/null`], { encoding: 'utf8' });
  return (r.stdout || '').split(/\s+/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
}

function killTree(pid) {
  // `uv run litellm` spawns litellm as a CHILD of uv — killing only the uv
  // parent (the pid we stored) orphans the Python litellm server still bound
  // to the port. Kill the whole tree.
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* group may not exist */ }
  }
}

function stop() {
  const pid = readPid();
  if (!pid) { log('not running (no pidfile)'); return; }
  if (!isRunning(pid)) { log(`stale pidfile (pid ${pid} not alive); removing`); fs.rmSync(pidFile, { force: true }); return; }
  try {
    killTree(pid);
    log(`killed process tree rooted at pid ${pid}`);
    // Give a short grace then force-clean the pidfile either way.
    setTimeout(() => {
      fs.rmSync(pidFile, { force: true });
      if (isRunning(pid)) {
        log(`warning: pid ${pid} still alive after tree kill`);
      } else {
        log('stopped');
      }
    }, 800);
  } catch (err) {
    log(`failed to stop pid ${pid}: ${err.message}`);
    fs.rmSync(pidFile, { force: true });
  }
}

/** GET /health/liveness → resolve true on 200, false otherwise. */
function healthCheck(loud) {
  return new Promise((resolve) => {
    const req = http.get(`${baseUrl}/health/liveness`, { timeout: 2000 }, (res) => {
      res.resume();
      const ok = res.statusCode === 200;
      if (loud) log(ok ? `UP at ${baseUrl}` : `DOWN (status ${res.statusCode}) at ${baseUrl}`);
      resolve(ok);
    });
    req.on('error', (err) => {
      if (loud) log(`DOWN at ${baseUrl} (${err.message})`);
      resolve(false);
    });
    req.on('timeout', () => {
      req.destroy();
      if (loud) log(`DOWN at ${baseUrl} (timeout)`);
      resolve(false);
    });
  });
}

const cmd = process.argv[2];
switch (cmd) {
  case 'run': runForeground(); break;
  case 'start':
    // startBackground is async (port reclaim waits); surface failures so the
    // process exits non-zero instead of silently hanging on an unhandled rejection.
    startBackground().catch((err) => {
      log(`start failed: ${err.message}`);
      process.exit(1);
    });
    break;
  case 'stop': case 'down': stop(); break;
  case 'health': healthCheck(true).then((up) => process.exit(up ? 0 : 1)); break;
  default:
    log(`unknown command: ${cmd ?? '(none)'}`);
    log('usage: node scripts/proxy.mjs <run|start|stop|health>');
    process.exit(2);
}
