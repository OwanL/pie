import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { killShellOnly, killTree } from "./kill.js";

const READY_TOKEN = "__PI_READY__";
/** Default warmup wait (ms) for a bash process to print the ready marker.
 *  Overridable via {@link WarmBashPool} opts (env: PIE_BASH_WARMUP_TIMEOUT_MS). */
const DEFAULT_WARMUP_TIMEOUT_MS = 10_000;

/** Live pool metrics surfaced to the host status strip via the stats registry. */
export interface WarmBashPoolStats {
  poolSize: number;
  ready: number;
  warming: number;
  /** Warmup attempts that failed (timed out / shell unavailable). */
  totalWarmupFailures: number;
  disposed: boolean;
}

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
}

interface WarmWorker {
  child: ChildProcess;
  run(opts: WarmExecOpts): Promise<{ exitCode: number | null }>;
  kill(): void;
}

/**
 * A shared pool of pre-warmed bash processes (one per process, NOT per
 * session). Each worker is used for exactly one command then killed
 * (no cross-call cwd/env state leakage — the wrapper re-cds per command, so
 * sharing across sessions is safe) and a replacement is warmed in the
 * background. The pool aims for a configurable idle target ({@link size}):
 * {@link refill} spawns up to it and {@link setTarget} kills excess idle when
 * the target is lowered, so the total idle bash process count is capped
 * process-wide regardless of how many sessions are open. If no warm worker
 * is ready, `exec` fails immediately with {@link WarmExecError}; operations.ts
 * then uses a fresh `bash -c`. Parallel bursts therefore retain the built-in
 * executor's concurrency instead of queueing behind the idle target.
 */
export class WarmBashPool {
  /** Ready warm workers, waiting to be consumed. */
  private items: WarmWorker[] = [];
  private inflight = 0;
  /** Children still warming — tracked so `dispose` can kill them promptly. */
  private warmingChildren = new Set<ChildProcess>();
  private disabled = false;
  private size: number;
  private readonly shell: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly warmupTimeoutMs: number;
  private totalWarmupFailures = 0;

  constructor(opts: {
    size: number;
    shellPath: string;
    env?: NodeJS.ProcessEnv;
    /** Warmup wait (ms); 0 or omitted → {@link DEFAULT_WARMUP_TIMEOUT_MS}. */
    warmupTimeoutMs?: number;
  }) {
    this.size = opts.size;
    this.env = opts.env ?? process.env;
    this.shell = opts.shellPath;
    this.warmupTimeoutMs = opts.warmupTimeoutMs && opts.warmupTimeoutMs > 0
      ? opts.warmupTimeoutMs
      : DEFAULT_WARMUP_TIMEOUT_MS;
    for (let i = 0; i < this.size; i++) this.refill();
  }

  async exec(opts: WarmExecOpts): Promise<{ exitCode: number | null }> {
    // The pool is an acceleration cache, not a concurrency gate. If every warm
    // worker is busy, fail immediately so operations.ts uses the normal fresh
    // spawn path. Waiting behind the idle target silently capped parallel bash
    // calls and could strand them forever after a warmup failure.
    const worker = this.items.shift();
    if (!worker) {
      this.refill();
      throw new WarmExecError(this.disabled ? "pool-disposed" : "no-ready-worker");
    }
    this.refill();
    try {
      return await worker.run(opts);
    } finally {
      worker.kill();
      this.refill();
    }
  }

  /** Live pool metrics for the host status strip. `ready` is the count of idle
   *  warm workers; `warming` is the count of workers still warming up. */
  getStats(): WarmBashPoolStats {
    return {
      poolSize: this.size,
      ready: this.disabled ? 0 : this.items.length,
      warming: this.disabled ? 0 : this.inflight,
      totalWarmupFailures: this.totalWarmupFailures,
      disposed: this.disabled,
    };
  }

  /** Park a freshly-warmed worker unless the idle target is already full. */
  private deliver(w: WarmWorker | null): void {
    if (this.disabled) {
      w?.kill();
      return;
    }
    if (w && this.items.length < this.size) {
      this.items.push(w);
    } else if (w) {
      // At/above the idle target (target was lowered while this was warming,
      // or a refill raced). Kill it rather than letting idle exceed the target.
      w.kill();
    }
  }

  private refill(): void {
    if (this.disabled) return;
    // Keep `size` workers warm (idle + warming), but only if there's demand or
    // we're below the floor — avoids warming workers nobody will take.
    if (this.items.length + this.inflight >= this.size) return;
    this.inflight++;
    createWarmWorker(this.shell, this.env, this.warmingChildren, this.warmupTimeoutMs)
      .then((w) => {
        this.inflight--;
        this.deliver(w);
      })
      .catch(() => {
        this.inflight--;
        this.totalWarmupFailures++;
        this.deliver(null);
      });
  }

  /** Live-tune the idle target. Kills excess idle workers immediately; any
   *  warming workers that were spawned under the old (higher) target are killed
   *  by {@link deliver} when they land. If the target rose, spawns up to the new
   *  target (refill spawns one worker per call, so loop the difference). No-op
   *  for n < 0. */
  setTarget(n: number): void {
    this.size = Math.max(0, n);
    if (this.disabled) return;
    // Kill idle workers above the new (lower) target right away.
    while (this.items.length > this.size) {
      this.items.pop()!.kill();
    }
    // Spawn up to the new target if it rose (or we dipped below). refill()
    // spawns exactly one worker per call and increments `inflight` synchronously,
    // so this loop converges in `size - (items + inflight)` iterations.
    while (this.items.length + this.inflight < this.size) {
      this.refill();
    }
  }

  dispose(): void {
    this.disabled = true;
    for (const w of this.items) w.kill();
    this.items = [];
    for (const child of this.warmingChildren) killShellOnly(child);
    this.warmingChildren.clear();
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
  warmupTimeoutMs: number,
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
    await waitReady(child, warmupTimeoutMs);
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

function waitReady(child: ChildProcess, warmupTimeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killTree(child);
      reject(new WarmExecError("warmup-timeout"));
    }, warmupTimeoutMs);

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
    if (opts.signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
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
export class MarkerStripper {
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
        // No marker start: emit everything except a tail that could be a partial
        // prefix. A marker prefix of length L can start at the last L-1 bytes,
        // so keep only those.
        const keep = this.startNeedle.length - 1;
        const safeLen = Math.max(0, this.pending.length - keep);
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
      // Partial marker — keep the leading \n and marker prefix so a later chunk
      // can complete it. Do not skip the \n; it is part of the marker framing.
      this.pending = this.pending.subarray(idx);
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