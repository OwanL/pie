import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { killShellOnly, killTree } from "./kill.js";

const READY_TOKEN = "__PI_READY__";
const WARMUP_TIMEOUT_MS = 10_000;
const ACQUIRE_TIMEOUT_MS = 15_000; // backstop: a stuck warmup must not hang a bash call

/** Marker error for warm-pool protocol failures so operations.ts can fall back. */
export class WarmExecError extends Error {}

export interface WarmExecOpts {
  /** Shell command to run (with any leading `cd` already peeled — the wrapper re-cds). */
  command: string;
  /** Absolute effective cwd. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  /** True when the command contains a heredoc — `</dev/null` is still safe but
   *  we keep the flag for future tightening. */
  hasHeredoc?: boolean;
}

interface WarmWorker {
  child: ChildProcess;
  run(opts: WarmExecOpts): Promise<{ exitCode: number | null }>;
  kill(): void;
}

/**
 * A per-session pool of pre-warmed bash processes. Each worker is used for
 * exactly one command then killed (no cross-call cwd/env state leakage — the
 * safety model the fresh-spawn design chose) and a replacement is warmed in the
 * background. If no warm worker is ready, the caller falls back to a fresh
 * `bash -c` (today's exact path), so the pool can never make things slower.
 */
export class WarmBashPool {
  /** Ready warm workers, waiting to be consumed. */
  private items: WarmWorker[] = [];
  /** Acquires that are blocked waiting for a warming worker to land. */
  private waiters: Array<(w: WarmWorker | null) => void> = [];
  private inflight = 0;
  /** Children still warming — tracked so `dispose` can kill them promptly. */
  private warmingChildren = new Set<ChildProcess>();
  private disabled = false;
  private readonly size: number;
  private readonly shell: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: { size: number; shellPath: string; env?: NodeJS.ProcessEnv }) {
    this.size = opts.size;
    this.env = opts.env ?? process.env;
    this.shell = opts.shellPath;
    for (let i = 0; i < this.size; i++) this.refill();
  }

  async exec(opts: WarmExecOpts): Promise<{ exitCode: number | null }> {
    // Ensure a replacement starts warming for the NEXT call before we consume one.
    this.refill();
    const worker = await this.acquire();
    try {
      return await worker.run(opts);
    } finally {
      worker.kill();
      this.refill();
    }
  }

  /** Fast path: take a ready worker. Otherwise register as a waiter — the next
   *  warmup to land resolves us directly (no double-buffering). Bounded by an
   *  acquire timeout so a stuck warmup (e.g. bash unavailable) can never hang
   *  the caller; on timeout it throws and operations falls back to a fresh spawn. */
  private acquire(): Promise<WarmWorker> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift()!);
    this.refill(); // ensure at least one warmup is in flight for this waiter
    return new Promise<WarmWorker>((resolve, reject) => {
      let resolver: ((w: WarmWorker | null) => void) | undefined;
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(resolver!);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new WarmExecError("acquire-timeout"));
      }, ACQUIRE_TIMEOUT_MS);
      resolver = (w) => {
        clearTimeout(timer);
        if (w) resolve(w);
        else if (this.disabled) reject(new WarmExecError("pool-disposed"));
        // w === null && !disabled: a warmup failed transiently — `deliver`
        // already triggered a replacement warmup; stay registered and wait
        // (the timer is the backstop if warmups keep failing).
      };
      this.waiters.push(resolver);
    });
  }

  /** Hand a freshly-warmed worker to a waiting acquire, else park it. */
  private deliver(w: WarmWorker | null): void {
    if (this.disabled) {
      w?.kill();
      return;
    }
    if (w && this.waiters.length > 0) {
      this.waiters.shift()!(w);
    } else if (w) {
      this.items.push(w);
    } else if (this.waiters.length > 0) {
      // warmup failed with a waiter present — trigger a replacement, then the
      // waiter re-acquires recursively.
      this.refill();
    }
  }

  private refill(): void {
    if (this.disabled) return;
    // Keep `size` workers warm (idle + warming), but only if there's demand or
    // we're below the floor — avoids warming workers nobody will take.
    if (this.items.length + this.inflight >= this.size) return;
    this.inflight++;
    createWarmWorker(this.shell, this.env, this.warmingChildren)
      .then((w) => {
        this.inflight--;
        this.deliver(w);
      })
      .catch(() => {
        this.inflight--;
        this.deliver(null);
      });
  }

  dispose(): void {
    this.disabled = true;
    for (const w of this.items) w.kill();
    this.items = [];
    for (const child of this.warmingChildren) killShellOnly(child);
    this.warmingChildren.clear();
    // Reject waiters so callers fall back to a fresh spawn rather than hanging.
    for (const waiter of this.waiters) waiter(null);
    this.waiters = [];
  }

  /** Resolve once at least one warm worker is idle (or after timeout). Production
   *  pre-warms at session start so the first call usually finds a ready worker. */
  async ready(timeoutMs = 5_000): Promise<void> {
    if (this.items.length > 0) return;
    const deadline = Date.now() + timeoutMs;
    while (this.items.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
  }
}

async function createWarmWorker(
  shell: string,
  env: NodeJS.ProcessEnv,
  warmingChildren: Set<ChildProcess>,
): Promise<WarmWorker> {
  const child = spawn(shell, ["--norc", "--noprofile"], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  child.stdin?.on("error", () => {});
  warmingChildren.add(child);

  try {
    await waitReady(child);
  } finally {
    warmingChildren.delete(child);
  }

  const worker: WarmWorker = {
    child,
    async run(opts) {
      return runOnWorker(child, opts);
    },
    kill() {
      killShellOnly(child);
    },
  };
  return worker;
}

function waitReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killTree(child);
      reject(new WarmExecError("warmup-timeout"));
    }, WARMUP_TIMEOUT_MS);

    let buf = "";
    const onStdout = (data: Buffer) => {
      buf += data.toString("latin1");
      const idx = buf.indexOf(READY_TOKEN);
      if (idx !== -1) {
        clearTimeout(timer);
        child.stdout?.removeListener("data", onStdout);
        resolve();
      }
    };
    child.stdout?.on("data", onStdout);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new WarmExecError(e.message));
    });
    child.on("close", () => {
      clearTimeout(timer);
      reject(new WarmExecError("warmup-closed"));
    });
    try {
      child.stdin?.write(`echo ${READY_TOKEN}\n`);
    } catch {
      clearTimeout(timer);
      reject(new WarmExecError("stdin-write-failed"));
    }
  });
}

/**
 * Run a single command on a warm worker via a marker protocol:
 *   cd "<cwd>" && { <command> ; } </dev/null; printf '\n__PI_EXIT_<token>__%d__\n' "$?"
 *
 * - `</dev/null` prevents stdin-consuming commands (`cat`, REPLs) from eating
 *   the marker; it is safe with heredocs and pipes (those are per-command
 *   redirects that take precedence over the group redirect).
 * - We race MARKER-SEEN vs PROCESS-CLOSED. `exec`/`exit` replacing the shell
 *   closes the process before the marker → we use the real exit code.
 * - stdout is streamed to onData with the marker stripped; stderr passes through.
 */
function runOnWorker(child: ChildProcess, opts: WarmExecOpts): Promise<{ exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode || child.stdin?.destroyed) {
      reject(new WarmExecError("worker-dead"));
      return;
    }

    const token = randomBytes(6).toString("hex");
    const stripper = new MarkerStripper(token, opts.onData);

    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      killTree(child);
      reject(new Error("aborted"));
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.removeListener("close", onClose);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode });
    };

    const onStdout = (buf: Buffer) => {
      stripper.push(buf);
      if (stripper.done) settle(stripper.exitCode ?? null);
    };
    const onStderr = (buf: Buffer) => {
      if (!stripper.done) opts.onData(buf);
    };
    const onClose = (code: number | null) => {
      stripper.flushRemaining();
      settle(code);
    };

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("close", onClose);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        killTree(child);
        reject(new Error(`timeout:${opts.timeout}`));
      }, opts.timeout * 1000);
    }

    // Construct the command. Newlines around the `{ ... }` group are REQUIRED so
    // that a heredoc's delimiter line (e.g. a trailing `EOF`) sits alone —
    // otherwise `{ cat <<EOF\n...\nEOF ; }` makes `EOF ; }` not-a-delimiter and
    // bash blocks forever waiting for the heredoc terminator.
    //   cd "<cwd>" && {
    //   <command>
    //   } </dev/null
    //   printf '\n__PI_EXIT_<token>__%d__\n' "$?"
    // `</dev/null` on the group prevents stdin-consuming commands (cat, REPLs)
    // from eating the marker; it is safe with heredocs and pipes (per-command
    // redirects take precedence over the group redirect).
    const cmd = `cd ${bashQuote(opts.cwd)} && {\n${opts.command}\n} </dev/null\nprintf '\\n__PI_EXIT_${token}__%d__\\n' "$?"\n`;
    try {
      child.stdin?.write(cmd);
    } catch {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new WarmExecError("stdin-write-failed"));
      }
    }
  });
}

/** Stream stdout to `emit`, stripping the trailing exit-marker line. */
class MarkerStripper {
  private pending = Buffer.alloc(0);
  private readonly startNeedle: Buffer;
  private readonly fullRe: RegExp;
  done = false;
  exitCode: number | null = null;

  constructor(token: string, private readonly emit: (b: Buffer) => void) {
    this.startNeedle = Buffer.from(`\n__PI_EXIT_${token}__`);
    this.fullRe = new RegExp(`^__PI_EXIT_${token}__(\\d+)__\\n`);
  }

  push(chunk: Buffer): void {
    if (this.done) return;
    this.pending = Buffer.concat([this.pending, chunk]);
    for (;;) {
      const idx = this.pending.indexOf(this.startNeedle);
      if (idx === -1) {
        // No marker start: emit everything except a tail that could be a partial prefix.
        const safeLen = Math.max(0, this.pending.length - this.startNeedle.length);
        if (safeLen > 0) {
          this.emit(this.pending.subarray(0, safeLen));
          this.pending = this.pending.subarray(safeLen);
        }
        return;
      }
      // Emit everything before the marker (the leading \n belongs to the marker framing).
      if (idx > 0) this.emit(this.pending.subarray(0, idx));
      const after = this.pending.subarray(idx + 1); // skip the \n
      const m = this.fullRe.exec(after.toString("latin1"));
      if (m) {
        this.exitCode = Number.parseInt(m[1] ?? "0", 10) || 0;
        this.done = true;
        this.pending = Buffer.alloc(0);
        return;
      }
      // Partial marker — hold and wait for more bytes.
      this.pending = after;
      return;
    }
  }

  /** Called on process close without a complete marker (exec/exit/crash). */
  flushRemaining(): void {
    if (this.done || this.pending.length === 0) return;
    this.emit(this.pending);
    this.pending = Buffer.alloc(0);
  }
}

/** Single-quote a path for bash, normalising backslashes (Git Bash friendly). */
function bashQuote(s: string): string {
  return "'" + s.replace(/\\/g, "/").replace(/'/g, "'\\''") + "'";
}