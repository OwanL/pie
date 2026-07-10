/**
 * warm-bash — speed up the bash tool by hiding shell-spawn latency.
 *
 * Replaces the built-in `bash` tool with one that uses a layered executor:
 *   1. fast-path  — execFile for simple commands (no bash.exe at all)
 *   2. warm-bash  — a per-session pool of pre-warmed bash processes with a
 *                   marker protocol; each worker is used once then killed
 *                   (no cross-call cwd/env leakage) and replaced in the background
 *   3. fallback   — the built-in fresh `bash -c` path (today's exact behaviour)
 *
 * Every layer degrades to the next; the fallback is today's path, so this can
 * never be slower or wrong versus the status quo. The built-in rendering
 * (streaming, truncation, "Took Xs") is inherited by spreading the base tool
 * and overriding only `execute`.
 *
 * Config (env vars, mirrored from runtimePrefs in the host):
 *   PIE_BASH_WARM_POOL   — warm pool size per session (default 2; 0 = disabled)
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

function poolSize(): number {
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

export default function (pi: ExtensionAPI) {
  // Per-session state, keyed by session id (cwd is stable per pie session).
  const pools = new Map<string, WarmBashPool>();
  const tools = new Map<string, ReturnType<typeof createBashTool>>();
  const sessionCwd = new Map<string, { cwd: string }>();
  /** Per-session fast-path/fallback counters, shared with operations. */
  const metrics = new Map<string, ReturnType<typeof createWarmBashMetrics>>();
  /** Unregister functions for the per-session stats providers (registry). */
  const unregisterStats = new Map<string, () => void>();
  /** Snapshot of the env-derived config used to build each session's tool, so a
   *  live settings change (writes new env via runtimePrefs.set) is detected and
   *  the pool/tool rebuilt on the next bash call — no restart needed. */
  const toolConfig = new Map<string, { size: number; fastPath: boolean; shell: string; warmup: number; acquire: number; autoPrune: boolean }>();

  function currentConfig() {
    return { size: poolSize(), fastPath: fastPathEnabled(), shell: shellPath(), warmup: warmupTimeoutMs(), acquire: acquireTimeoutMs(), autoPrune: autoPruneEnabled() };
  }

  function getPool(sessionId: string, size: number, shell: string, warmup: number, acquire: number): WarmBashPool | null {
    if (size <= 0) return null;
    let p = pools.get(sessionId);
    if (!p) {
      p = new WarmBashPool({ size, env: process.env, shellPath: shell, warmupTimeoutMs: warmup, acquireTimeoutMs: acquire });
      pools.set(sessionId, p);
    }
    return p;
  }

  function getTool(sessionId: string, cwd: string): ReturnType<typeof createBashTool> {
    let entry = sessionCwd.get(sessionId);
    if (!entry) {
      entry = { cwd };
      sessionCwd.set(sessionId, entry);
    }
    entry.cwd = cwd; // keep current in case a session ever changes cwd

    const cfg = currentConfig();
    const prev = toolConfig.get(sessionId);
    // If a setting changed since we built this session's tool, tear it down and
    // rebuild so the new pool size / fast-path / shell / timeouts takes effect
    // immediately.
    if (prev && (prev.size !== cfg.size || prev.fastPath !== cfg.fastPath || prev.shell !== cfg.shell || prev.warmup !== cfg.warmup || prev.acquire !== cfg.acquire || prev.autoPrune !== cfg.autoPrune)) {
      pools.get(sessionId)?.dispose();
      pools.delete(sessionId);
      tools.delete(sessionId);
      toolConfig.delete(sessionId);
      // Re-register the stats provider against the new pool below.
      unregisterStats.get(sessionId)?.();
      unregisterStats.delete(sessionId);
      metrics.delete(sessionId);
    }

    let tool = tools.get(sessionId);
    if (!tool) {
      const pool = getPool(sessionId, cfg.size, cfg.shell, cfg.warmup, cfg.acquire);
      // Fallback = today's exact path. Pass the same explicit shell so the
      // fallback and warm pool use one bash binary.
      const fallbackOps = createLocalBashOperations({
        shellPath: cfg.shell || undefined,
      }) as BashOperations;
      const m = createWarmBashMetrics();
      metrics.set(sessionId, m);
      const operations = createWarmBashOperations({
        pool,
        fastPathEnabled: cfg.fastPath,
        autoPruneEnabled: cfg.autoPrune,
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
      toolConfig.set(sessionId, cfg);
      // Register a live stats provider so the host status strip can show
      // ready/warming counts + execution breakdown for this session.
      const unregister = registerWarmBashStats(sessionId, (): WarmBashStats => {
        const ps = pool?.getStats() ?? null;
        const enabled = !!ps && !ps.disposed && cfg.size > 0;
        return {
          enabled,
          activeSessions: enabled ? 1 : 0,
          poolSize: ps ? ps.poolSize : 0,
          ready: ps ? ps.ready : 0,
          warming: ps ? ps.warming : 0,
          fastPathEnabled: cfg.fastPath,
          totalFastPath: m.totalFastPath,
          totalWarm: m.totalWarm,
          totalFallback: m.totalFallback,
          totalWarmupFailures: ps ? ps.totalWarmupFailures : 0,
        };
      });
      unregisterStats.set(sessionId, unregister);
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
    const pool = pools.get(id) ?? null;
    const m = metrics.get(id);
    const cfg = toolConfig.get(id);
    // Persist the session's cumulative routing counters + config context BEFORE
    // disposing the pool (getStats() would read disposed afterwards). Only
    // sessions that actually invoked bash have metrics (getTool created them).
    if (m && cfg) {
      const ps = pool?.getStats() ?? null;
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
    pool?.dispose();
    pools.delete(id);
    tools.delete(id);
    sessionCwd.delete(id);
    toolConfig.delete(id);
    unregisterStats.get(id)?.();
    unregisterStats.delete(id);
    metrics.delete(id);
    // Best-effort drain so the summary line lands on disk before the worker exits.
    await flushLog();
  });

  // Best-effort cleanup if the process exits without per-session shutdown.
  for (const sig of ["exit", "SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      for (const p of pools.values()) p.dispose();
    });
  }
}