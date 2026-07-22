import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { resolveBinary } from "./resolve.js";
import { killTree } from "./kill.js";

/** Marker error so operations.ts can distinguish fast-path failures to fall back. */
export class FastPathError extends Error {}

export interface FastPathOpts {
  program: string;
  args: string[];
  /** Peeled cd target (relative) or null. */
  cwd: string | null;
  /** Session cwd — used to resolve a relative cwd. */
  baseCwd: string;
  env?: NodeJS.ProcessEnv;
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
}

/**
 * Run a simple command directly (no shell). Throws FastPathError on ENOENT
 * (caller falls back to a shell); throws Error("aborted" | "timeout:N") on
 * cancel/timeout (caller propagates, matching the built-in bash tool).
 */
export async function execFastPath(opts: FastPathOpts): Promise<{ exitCode: number | null }> {
  // In-process `echo` with no flags — extremely common in agent output
  // (section headers etc.) and trivially correct without any spawn.
  if (opts.program === "echo" && opts.args.every((a) => !a.startsWith("-"))) {
    onDataEcho(opts.args, opts.onData);
    return { exitCode: 0 };
  }

  // Resolve against the execution env's PATH (not process.env.PATH) so pi's
  // managed-bin directory — prepended to PATH by the host for this call — is
  // honoured and rg/fd fast-path instead of falling back to a shell.
  const binary = resolveBinary(opts.program, opts.env);
  if (!binary) throw new FastPathError(`ENOENT: ${opts.program}`);

  const cwd = opts.cwd ? resolve(opts.baseCwd, opts.cwd) : opts.baseCwd;
  return execBinary(binary, opts.args, cwd, opts.env, opts.onData, opts.signal, opts.timeout);
}

function onDataEcho(args: string[], onData: (b: Buffer) => void): void {
  // bash `echo` with no flags joins args with single spaces and appends a newline.
  onData(Buffer.from(args.join(" ") + "\n"));
}

function execBinary(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  onData: (b: Buffer) => void,
  signal: AbortSignal | undefined,
  timeout: number | undefined,
): Promise<{ exitCode: number | null }> {
  return new Promise((resolveExec, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const child = spawn(binary, args, {
      cwd,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => killTree(child);

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    if (timeout && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeout * 1000);
    }

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => {
      cleanup();
      reject(new FastPathError(e.message));
    });
    child.on("close", (code) => {
      cleanup();
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      if (timedOut) {
        reject(new Error(`timeout:${timeout}`));
        return;
      }
      resolveExec({ exitCode: code });
    });
  });
}

