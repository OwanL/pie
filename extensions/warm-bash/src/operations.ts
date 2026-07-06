import { resolve } from "node:path";
import { classify } from "./classifier.js";
import { execFastPath, FastPathError } from "./fast-path.js";
import { WarmBashPool, WarmExecError } from "./warm-pool.js";
import type { BashOperations } from "./types.js";

/** Mutable counters shared with the per-session stats provider (index.ts).
 *  Each counter increments when a command is ROUTED to that path AND does not
 *  degrade further: fast path counts successful execFile returns (an ENOENT
 *  fall-through is NOT counted — it degraded to the shell paths); warm counts
 *  warm-pool execs that returned or threw a terminal/unexpected error (a
 *  WarmExecError that fell back is NOT counted); fallback always counts (it is
 *  the terminal layer). So the three counters sum to the number of distinct
 *  commands executed. */
export interface WarmBashMetrics {
  totalFastPath: number;
  totalWarm: number;
  totalFallback: number;
}

export function createWarmBashMetrics(): WarmBashMetrics {
  return { totalFastPath: 0, totalWarm: 0, totalFallback: 0 };
}

export interface WarmBashOpsOpts {
  /** Per-session warm pool, or null when warm mode is disabled. */
  pool: WarmBashPool | null;
  fastPathEnabled: boolean;
  /** Today's exact execution path, injected by index.ts (createLocalBashOperations).
   *  Used as the final fallback so this layer can never be worse than the status quo. */
  fallbackOps: BashOperations;
  /** Counters incremented per execution path (for the host status strip). */
  metrics?: WarmBashMetrics;
}

/** A command failure that is terminal for this call (must propagate, not fall back). */
function isTerminal(message: string): boolean {
  return message === "aborted" || message.startsWith("timeout:");
}

/**
 * Build a BashOperations that implements the layered decision tree:
 *   1. fast-path  — execFile for simple commands (no shell at all)
 *   2. warm-bash  — pre-warmed shell + marker protocol (kill-after-use)
 *   3. fallback   — the injected ops, i.e. today's exact path
 *
 * Every layer fails down to the next; the fallback is the current behaviour,
 * so this can never produce a worse result than today.
 */
export function createWarmBashOperations(opts: WarmBashOpsOpts): BashOperations {
  const fallback = opts.fallbackOps;

  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      const c = classify(command);
      const effCwd = c.cwd ? resolve(cwd, c.cwd) : cwd;

      // 1. Fast path (simple commands only).
      if (c.kind === "simple" && opts.fastPathEnabled && c.program && c.args) {
        try {
          const r = await execFastPath({
            program: c.program,
            args: c.args,
            cwd: c.cwd,
            baseCwd: cwd,
            env,
            onData,
            signal,
            timeout,
          });
          if (opts.metrics) opts.metrics.totalFastPath++;
          return r;
        } catch (e) {
          const msg = (e as Error).message;
          if (isTerminal(msg)) {
            // Aborted/timed-out — the command WAS a fast-path execution, count it.
            if (opts.metrics) opts.metrics.totalFastPath++;
            throw e;
          }
          // ENOENT / non-terminal → fall through to the shell paths (not counted).
        }
      }

      // 2. Warm bash (shell-needing commands). Uses the peeled `rest` + effCwd
      //    so the wrapper re-applies cd exactly once.
      if (opts.pool) {
        try {
          const r = await opts.pool.exec({
            command: c.rest,
            cwd: effCwd,
            env,
            onData,
            signal,
            timeout,
            hasHeredoc: c.hasHeredoc,
          });
          if (opts.metrics) opts.metrics.totalWarm++;
          return r;
        } catch (e) {
          const msg = (e as Error).message;
          if (isTerminal(msg)) {
            if (opts.metrics) opts.metrics.totalWarm++;
            throw e;
          }
          if (!(e instanceof WarmExecError)) {
            // Unexpected non-warm error — the command was a warm execution, count it.
            if (opts.metrics) opts.metrics.totalWarm++;
            throw e;
          }
          // WarmExecError (non-terminal) → fall back to a fresh spawn (not counted).
        }
      }

      // 3. Fallback: today's exact path (original command, session cwd).
      if (opts.metrics) opts.metrics.totalFallback++;
      return fallback.exec(command, cwd, { onData, signal, timeout, env });
    },
  };
}