/**
 * warm-bash — speed up the bash tool by hiding shell-spawn latency.
 *
 * Replaces the built-in `bash` tool with one that uses a layered executor:
 *   1. fast-path  — execFile for simple commands (no bash.exe at all)
 *   2. warm-bash  — a SINGLE SHARED pool of pre-warmed bash processes with a
 *                   marker protocol; each worker is used once then killed
 *                   (no cross-call cwd/env leakage) and replaced in the
 *                   background. The pool aims for a configurable IDLE TARGET
 *                   (PIE_BASH_WARM_POOL): it spawns up to the target when idle
 *                   drops below it and kills excess idle when the target is
 *                   lowered — so the total idle bash process count is capped
 *                   process-wide regardless of how many sessions are open.
 *   3. fallback   — the built-in fresh `bash -c` path (today's exact behaviour)
 *
 * Every layer degrades to the next; the fallback is today's path, so this can
 * never be slower or wrong versus the status quo. The built-in rendering
 * (streaming, truncation, "Took Xs") is inherited by spreading the base tool
 * and overriding only `execute`.
 *
 * Config (env vars, mirrored from runtimePrefs in the host):
 *   PIE_BASH_WARM_POOL   — idle target for the SHARED pool (default 2; 0 = disabled)
 *   PIE_BASH_FAST_PATH   — "1"/"0" (default 1; 0 disables the execFile fast path)
 *   PIE_SHELL            — explicit bash path (default: auto-detect Git Bash / bash)
 *   PIE_BASH_WARMUP_TIMEOUT_MS — warmup wait ms (default 10000; 0 = default)
 *   PIE_BASH_ACQUIRE_TIMEOUT_MS — acquire wait ms (default 15000; 0 = default)
 */

import { createBashTool, createLocalBashOperations, getShellConfig, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWarmBashOperations, createWarmBashMetrics } from "./src/operations.js";
import { probeGnuGrep } from "./src/auto-prune.js";
import { logAutoPruneRewrite, logSessionSummary, flushLog, type WarmBashSessionSummary } from "./src/logger.js";
import { WarmBashPool } from "./src/warm-pool.js";
import { registerWarmBashStats, type WarmBashStats } from "./src/stats.js";
import { effectiveTimeout, parseDefaultTimeout } from "./src/timeout.js";
import type { BashOperations } from "./src/types.js";

function idleTarget(): number {
  const raw = Number.parseInt(process.env.PIE_BASH_WARM_POOL ?? "", 10);
  return Number.isFinite(raw) ? Math.max(0, raw) : 2;
}

function fastPathEnabled(): boolean {
  const v = (process.env.PIE_BASH_FAST_PATH ?? "1").toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

/** Transparent search-pruning guard (inject --exclude-dir / -prune into recursive
 *  grep / bare-path find). Default on; "0" skips the rewrite entirely, preserving
 *  the "never worse than status quo" guarantee. Read fresh on every tool build so
 *  a settings change hot-reloads without a restart (same pattern as fastPathEnabled). */
function autoPruneEnabled(): boolean {
  const v = (process.env.PIE_BASH_AUTO_PRUNE ?? "1").toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

function shellPath(): string {
  const explicit = process.env.PIE_SHELL?.trim();
  if (explicit) return explicit;
  // Resolve via pi's shell config (Git Bash on Windows, bash/sh on Unix).
  return getShellConfig().shell;
}

function warmupTimeoutMs(): number {
  const raw = Number.parseInt(process.env.PIE_BASH_WARMUP_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

function acquireTimeoutMs(): number {
  const raw = Number.parseInt(process.env.PIE_BASH_ACQUIRE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

/** Cached GNU-grep capability probe (keyed by shell so a PIE_SHELL change
 *  re-probes). grep injection is gated on this so a non-GNU environment never
 *  gets a broken `--exclude-dir` grep. */
let gnuGrepCache: { shell: string; gnu: boolean } | null = null;
function gnuGrepProbe(): boolean {
  const shell = shellPath();
  if (gnuGrepCache && gnuGrepCache.shell === shell) return gnuGrepCache.gnu;
  const gnu = probeGnuGrep(shell);
  gnuGrepCache = { shell, gnu };
  return gnu;
}

/** Default timeout (seconds) for bash commands that don't specify one.
 *  The upstream SDK default is 600s, which lets a hung simple command block a
 *  session for 10 minutes. We default to 60s and allow up to 600s when the
 *  caller explicitly asks for a long-running command. */
const BASH_DEFAULT_TIMEOUT = 60;
const BASH_MAX_TIMEOUT = 600;

function defaultTimeout(): number {
  return parseDefaultTimeout(process.env.PIE_BASH_DEFAULT_TIMEOUT, BASH_DEFAULT_TIMEOUT, BASH_MAX_TIMEOUT);
}

/** Honor the host's per-extension toggle (PIE_EXTENSION_TOGGLES_JSON, keyed by
 *  extension id). Mirrors skill-pruner's isExtensionDisabledByToggle so the
 *  Settings → Extensions checkbox actually disables this override at runtime.
 *  When disabled we fall back to the built-in fresh `bash -c` path (today's
 *  exact behaviour) by delegating to the base tool — never slower or wrong
 *  versus the status quo. */
function isDisabledByToggle(): boolean {
  const raw = process.env['PIE_EXTENSION_TOGGLES_JSON'];
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed['warm-bash'] === false;
  } catch {
    return false;
  }
}

// Base built-in bash tool, spread for its schema / promptSnippet / rendering.
// Its execute is overridden per call; the throwaway cwd never runs a command.
const baseBashTool = createBashTool(process.cwd());

interface PoolCfg {
  target: number;
  shell: string;
  warmup: number;
  acquire: number;
}
interface OpsCfg {
  fastPath: boolean;
  autoPrune: boolean;
}

export default function (pi: ExtensionAPI) {
  // SHARED pool — one process-wide warm pool, NOT per-session. Workers are
  // single-use (used once then killed, re-cd'd per command), so sharing across
  // sessions never reintroduces cross-call cwd/env state leakage. This caps the
  // total idle bash process count at the target regardless of session count.
  let sharedPool: WarmBashPool | null = null;
  let poolCfg: PoolCfg | null = null;
  let unregisterStats: (() => void) | null = null;

  // Per-session state. Tools + operations are per-session (operations holds a
  // per-session log closure keyed by sessionId); the POOL they reference is shared.
  const tools = new Map<string, ReturnType<typeof createBashTool>>();
  const sessionCwd = new Map<string, { cwd: string }>();
  /** Per-session fast-path/fallback counters (for analytics) + summed into the
   *  global stats provider. */
  const metrics = new Map<string, ReturnType<typeof createWarmBashMetrics>>();
  /** Sessions that have built a warm-bash tool — drives `activeSessions` in stats. */
  const activeSessions = new Set<string>();
  /** Last ops config used to build each session's tool, to detect fast-path /
   *  auto-prune changes and rebuild the tool (cheap; no pool change). */
  const toolOpsCfg = new Map<string, OpsCfg>();
  /** Global ops-config snapshot — a change invalidates ALL per-session tools. */
  let globalOpsCfg: OpsCfg | null = null;

  function currentPoolCfg(): PoolCfg {
    return { target: idleTarget(), shell: shellPath(), warmup: warmupTimeoutMs(), acquire: acquireTimeoutMs() };
  }
  function currentOpsCfg(): OpsCfg {
    return { fastPath: fastPathEnabled(), autoPrune: autoPruneEnabled() };
  }

  /** Bring the shared pool in line with `cfg`. Creates, disposes, live-tunes the
   *  target, or rebuilds (on shell/timeout change). When the pool is rebuilt or
   *  disabled, all per-session tools are invalidated so their operations pick up
   *  the new pool (an old operations closure would reference a disposed pool). */
  function reconcilePool(cfg: PoolCfg): void {
    // Disable path: tear the pool down entirely.
    if (cfg.target <= 0) {
      if (sharedPool) {
        sharedPool.dispose();
        sharedPool = null;
        poolCfg = null;
        invalidateAllTools();
      }
      return;
    }

    if (!sharedPool) {
      sharedPool = new WarmBashPool({
        size: cfg.target,
        env: process.env,
        shellPath: cfg.shell,
        warmupTimeoutMs: cfg.warmup,
        acquireTimeoutMs: cfg.acquire,
      });
      poolCfg = cfg;
      registerGlobalStats();
      // Existing sessions cached tools whose operations captured pool:null
      // (built while the pool was disabled). Invalidate so they rebuild and
      // pick up the new shared pool.
      invalidateAllTools();
      return;
    }

    const prev = poolCfg!;
    // Shell / warmup / acquire changes require a rebuild (workers use the old
    // shell; timeouts are baked at construction).
    if (prev.shell !== cfg.shell || prev.warmup !== cfg.warmup || prev.acquire !== cfg.acquire) {
      sharedPool.dispose();
      sharedPool = new WarmBashPool({
        size: cfg.target,
        env: process.env,
        shellPath: cfg.shell,
        warmupTimeoutMs: cfg.warmup,
        acquireTimeoutMs: cfg.acquire,
      });
      poolCfg = cfg;
      invalidateAllTools();
      return;
    }

    // Only the target changed — live-tune without a rebuild (existing operations
    // keep referencing the same pool object).
    if (prev.target !== cfg.target) {
      sharedPool.setTarget(cfg.target);
      poolCfg = cfg;
    }
  }

  function invalidateAllTools(): void {
    tools.clear();
    toolOpsCfg.clear();
  }

  /** One global stats provider (NOT per-session). Sums per-session metrics for
   *  the routing totals and reads the shared pool for ready/warming/poolSize. */
  function registerGlobalStats(): void {
    unregisterStats?.();
    unregisterStats = registerWarmBashStats('__warm-bash-global__', (): WarmBashStats => {
      const ps = sharedPool?.getStats() ?? null;
      const enabled = !!ps && !ps.disposed;
      let totalFastPath = 0;
      let totalWarm = 0;
      let totalFallback = 0;
      for (const m of metrics.values()) {
        totalFastPath += m.totalFastPath;
        totalWarm += m.totalWarm;
        totalFallback += m.totalFallback;
      }
      return {
        enabled,
        activeSessions: enabled ? activeSessions.size : 0,
        poolSize: ps ? ps.poolSize : 0,
        ready: ps ? ps.ready : 0,
        warming: ps ? ps.warming : 0,
        fastPathEnabled: fastPathEnabled(),
        totalFastPath,
        totalWarm,
        totalFallback,
        totalWarmupFailures: ps ? ps.totalWarmupFailures : 0,
      };
    });
  }

  function getTool(sessionId: string, cwd: string): ReturnType<typeof createBashTool> {
    let entry = sessionCwd.get(sessionId);
    if (!entry) {
      entry = { cwd };
      sessionCwd.set(sessionId, entry);
    }
    entry.cwd = cwd; // keep current in case a session ever changes cwd

    const poolCfgNow = currentPoolCfg();
    const opsCfgNow = currentOpsCfg();
    reconcilePool(poolCfgNow);
    activeSessions.add(sessionId);

    // Global ops-config change (fastPath / autoPrune) → rebuild every session's
    // tool so its operations picks up the new flags. Cheap; no pool change.
    if (globalOpsCfg && (globalOpsCfg.fastPath !== opsCfgNow.fastPath || globalOpsCfg.autoPrune !== opsCfgNow.autoPrune)) {
      invalidateAllTools();
    }
    globalOpsCfg = opsCfgNow;

    // Per-session ops-config drift (e.g. tool built before a global update
    // landed in the map) → rebuild just this session.
    const prevOps = toolOpsCfg.get(sessionId);
    if (prevOps && (prevOps.fastPath !== opsCfgNow.fastPath || prevOps.autoPrune !== opsCfgNow.autoPrune)) {
      tools.delete(sessionId);
    }

    let tool = tools.get(sessionId);
    if (!tool) {
      const pool = sharedPool;
      // Fallback = today's exact path. Pass the same explicit shell so the
      // fallback and warm pool use one bash binary.
      const fallbackOps = createLocalBashOperations({
        shellPath: poolCfgNow.shell || undefined,
      }) as BashOperations;
      const m = createWarmBashMetrics();
      metrics.set(sessionId, m);
      const operations = createWarmBashOperations({
        pool,
        fastPathEnabled: opsCfgNow.fastPath,
        autoPruneEnabled: opsCfgNow.autoPrune,
        gnuGrepProbe,
        log: (payload) => {
          // Live debug line for the pi OutputChannel (pi-logs) + persisted
          // side-channel record for analytics ingestion.
          console.error(JSON.stringify(payload));
          logAutoPruneRewrite(sessionId, payload.before as string, payload.after as string);
        },
        fallbackOps,
        metrics: m,
      });
      // spawnHook overrides the baked cwd with the live per-session cwd on every call.
      tool = createBashTool(entry.cwd, {
        operations,
        spawnHook: ({ command, cwd: _cwd, env }: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => ({ command, cwd: entry!.cwd, env }),
      });
      tools.set(sessionId, tool);
      toolOpsCfg.set(sessionId, opsCfgNow);
    }
    return tool;
  }

  pi.registerTool({
    ...baseBashTool,
    async execute(toolCallId: string, params: { command: string; timeout?: number }, signal: AbortSignal | undefined, onUpdate: ((u: unknown) => void) | undefined, ctx: { cwd: string; sessionManager: { getSessionId: () => string } }) {
      // When the extension is toggled off, skip the warm pool/fast-path layers
      // and run the built-in fresh `bash -c` path directly.
      if (isDisabledByToggle()) {
        const effectiveParams = {
          ...params,
          timeout: effectiveTimeout({ timeout: params.timeout, defaultTimeout: defaultTimeout(), maxTimeout: BASH_MAX_TIMEOUT }),
        };
        return baseBashTool.execute(toolCallId, effectiveParams, signal, onUpdate);
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const tool = getTool(sessionId, ctx.cwd);
      const effectiveParams = {
        ...params,
        timeout: effectiveTimeout({ timeout: params.timeout, defaultTimeout: defaultTimeout(), maxTimeout: BASH_MAX_TIMEOUT }),
      };
      return tool.execute(toolCallId, effectiveParams, signal, onUpdate);
    },
    // renderCall / renderResult intentionally omitted → built-in inherited.
  });

  pi.on("session_shutdown", async (_event: unknown, ctx: { sessionManager: { getSessionId: () => string } }) => {
    const id = ctx.sessionManager.getSessionId();
    const m = metrics.get(id);
    const cfg = globalOpsCfg;
    // Persist the session's cumulative routing counters + config context BEFORE
    // removing the per-session metrics (the global stats provider sums them).
    // Only sessions that actually invoked bash have metrics (getTool created them).
    if (m && cfg) {
      const ps = sharedPool?.getStats() ?? null;
      const summary: WarmBashSessionSummary = {
        fastPath: m.totalFastPath,
        warm: m.totalWarm,
        fallback: m.totalFallback,
        poolSize: ps ? ps.poolSize : 0,
        warmupFailures: ps ? ps.totalWarmupFailures : 0,
        autoPruneEnabled: cfg.autoPrune,
        fastPathEnabled: cfg.fastPath,
        gnuGrep: gnuGrepProbe(),
      };
      logSessionSummary(id, summary);
    }
    // Per-session teardown. The shared pool is NOT disposed here — it persists
    // for the process lifetime (or until the idle target is set to 0) so the
    // configured idle target is maintained across sessions.
    activeSessions.delete(id);
    tools.delete(id);
    sessionCwd.delete(id);
    toolOpsCfg.delete(id);
    metrics.delete(id);
    // Best-effort drain so the summary line lands on disk before the worker exits.
    await flushLog();
  });

  // Best-effort cleanup if the process exits without per-session shutdown.
  for (const sig of ["exit", "SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      sharedPool?.dispose();
    });
  }
}