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
 */

import { createBashTool, createLocalBashOperations, getShellConfig, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWarmBashOperations } from "./src/operations.js";
import { WarmBashPool } from "./src/warm-pool.js";
import type { BashOperations } from "./src/types.js";

function poolSize(): number {
  const raw = Number.parseInt(process.env.PIE_BASH_WARM_POOL ?? "", 10);
  return Number.isFinite(raw) ? Math.max(0, raw) : 2;
}

function fastPathEnabled(): boolean {
  const v = (process.env.PIE_BASH_FAST_PATH ?? "1").toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

function shellPath(): string {
  const explicit = process.env.PIE_SHELL?.trim();
  if (explicit) return explicit;
  // Resolve via pi's shell config (Git Bash on Windows, bash/sh on Unix).
  return getShellConfig().shell;
}

// Base built-in bash tool, spread for its schema / promptSnippet / rendering.
// Its execute is overridden per call; the throwaway cwd never runs a command.
const baseBashTool = createBashTool(process.cwd());

export default function (pi: ExtensionAPI) {
  // Per-session state, keyed by session id (cwd is stable per pie session).
  const pools = new Map<string, WarmBashPool>();
  const tools = new Map<string, ReturnType<typeof createBashTool>>();
  const sessionCwd = new Map<string, { cwd: string }>();

  function getPool(sessionId: string): WarmBashPool | null {
    const size = poolSize();
    if (size <= 0) return null;
    let p = pools.get(sessionId);
    if (!p) {
      p = new WarmBashPool({ size, env: process.env, shellPath: shellPath() });
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

    let tool = tools.get(sessionId);
    if (!tool) {
      const pool = getPool(sessionId);
      // Fallback = today's exact path. Pass the same explicit shell so the
      // fallback and warm pool use one bash binary.
      const fallbackOps = createLocalBashOperations({
        shellPath: process.env.PIE_SHELL?.trim() || undefined,
      }) as BashOperations;
      const operations = createWarmBashOperations({
        pool,
        fastPathEnabled: fastPathEnabled(),
        fallbackOps,
      });
      // spawnHook overrides the baked cwd with the live per-session cwd on every call.
      tool = createBashTool(entry.cwd, {
        operations,
        spawnHook: ({ command, cwd: _cwd, env }: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => ({ command, cwd: entry!.cwd, env }),
      });
      tools.set(sessionId, tool);
    }
    return tool;
  }

  pi.registerTool({
    ...baseBashTool,
    async execute(toolCallId: string, params: { command: string; timeout?: number }, signal: AbortSignal | undefined, onUpdate: ((u: unknown) => void) | undefined, ctx: { cwd: string; sessionManager: { getSessionId: () => string } }) {
      const sessionId = ctx.sessionManager.getSessionId();
      const tool = getTool(sessionId, ctx.cwd);
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
    // renderCall / renderResult intentionally omitted → built-in inherited.
  });

  pi.on("session_shutdown", async (_event: unknown, ctx: { sessionManager: { getSessionId: () => string } }) => {
    const id = ctx.sessionManager.getSessionId();
    pools.get(id)?.dispose();
    pools.delete(id);
    tools.delete(id);
    sessionCwd.delete(id);
  });

  // Best-effort cleanup if the process exits without per-session shutdown.
  for (const sig of ["exit", "SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      for (const p of pools.values()) p.dispose();
    });
  }
}