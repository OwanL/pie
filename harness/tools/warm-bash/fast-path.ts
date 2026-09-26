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

const EXIT_STDIO_IDLE_GRACE_MS = 100;

/**
 * Wait for the direct child, not every descendant that inherited its pipes.
 *
 * On Windows, launchers such as `cmd.exe /c start …` exit promptly but the
 * program they launch can retain stdout/stderr. Node's `close` event then does
 * not fire until that descendant exits, which used to leave the tool—and
 * `session.abort()`—stuck indefinitely. After the direct child exits, keep
 * collecting active output, but release quiet inherited handles after a short
 * idle grace. This mirrors the SDK's fresh-bash executor.
 */
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
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (postExitTimer) clearTimeout(postExitTimer);
      signal?.removeEventListener("abort", onAbort);
      // Keep the one-shot error listener installed after local settlement.
      // Abort/timeout can finalize before an asynchronous spawn error arrives;
      // removing the final listener would turn that late error into an uncaught
      // EventEmitter exception in the extension host. The child remains
      // collectible with the listener attached.
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("data", onStdoutData);
      child.stderr?.removeListener("data", onStderrData);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
    };

    const finalize = (code = exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (signal?.aborted) {
        reject(new Error("aborted"));
      } else if (timedOut) {
        reject(new Error(`timeout:${timeout}`));
      } else {
        resolveExec({ exitCode: code });
      }
    };

    const armPostExitTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(), EXIT_STDIO_IDLE_GRACE_MS);
    };

    const maybeFinalizeAfterExit = () => {
      if (exited && stdoutEnded && stderrEnded) finalize();
    };

    const onStdoutData = (data: Buffer) => {
      onData(data);
      if (exited) armPostExitTimer();
    };
    const onStderrData = (data: Buffer) => {
      onData(data);
      if (exited) armPostExitTimer();
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new FastPathError(error.message));
    };
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armPostExitTimer();
    };
    const onClose = (code: number | null) => finalize(code);
    const onAbort = () => {
      killTree(child);
      // `close` may never fire when an already-exited launcher left inherited
      // pipes behind. The kill attempt is best-effort; local cancellation is
      // authoritative and must settle immediately.
      finalize();
    };

    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);
    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });

    if (timeout && timeout > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        finalize();
      }, timeout * 1000);
    }
  });
}

