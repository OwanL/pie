import { resolve } from "node:path";
import { classify } from "./classifier.js";
import { execFastPath, FastPathError } from "./fast-path.js";
import { WarmBashPool, WarmExecError } from "./warm-pool.js";
import type { BashOperations } from "./types.js";

export interface WarmBashOpsOpts {
  /** Per-session warm pool, or null when warm mode is disabled. */
  pool: WarmBashPool | null;
  fastPathEnabled: boolean;
  /** Today's exact execution path, injected by index.ts (createLocalBashOperations).
   *  Used as the final fallback so this layer can never be worse than the status quo. */
  fallbackOps: BashOperations;
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
          return await execFastPath({
            program: c.program,
            args: c.args,
            cwd: c.cwd,
            baseCwd: cwd,
            env,
            onData,
            signal,
            timeout,
          });
        } catch (e) {
          const msg = (e as Error).message;
          if (isTerminal(msg)) throw e;
          // ENOENT / non-terminal → fall through to shell.
        }
      }

      // 2. Warm bash (shell-needing commands). Uses the peeled `rest` + effCwd
      //    so the wrapper re-applies cd exactly once.
      if (opts.pool) {
        try {
          return await opts.pool.exec({
            command: c.rest,
            cwd: effCwd,
            env,
            onData,
            signal,
            timeout,
            hasHeredoc: c.hasHeredoc,
          });
        } catch (e) {
          const msg = (e as Error).message;
          if (isTerminal(msg)) throw e;
          if (!(e instanceof WarmExecError)) throw e;
          // Warm protocol failure → fall back to a fresh spawn.
        }
      }

      // 3. Fallback: today's exact path (original command, session cwd).
      return fallback.exec(command, cwd, { onData, signal, timeout, env });
    },
  };
}