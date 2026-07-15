# warm-bash

Speeds up the `bash` tool by hiding shell-spawn latency — especially the ~100–300ms
Git Bash startup tax on Windows — without changing semantics.

Replaces the built-in `bash` tool with a layered executor. **Every layer degrades to
the next; the final fallback is today's exact `bash -c` path, so this can never be
slower or wrong versus the status quo.** The built-in rendering (streaming,
truncation, "Took Xs") is inherited, so the UI is identical.

## How it works (per `bash` call)

1. **Fast path** — `execFile` for simple commands (one program + args, no shell
   metacharacters). **No bash.exe is spawned at all.** Windows `.cmd`/`.bat` shims
   (`npm`, `npx`, …) are resolved on PATH so they fast-path too. `echo` with no flags
   is served in-process (zero spawn) — it's the most common agent "command".
2. **Warm bash** — for commands that need a shell (pipes, `&&`, redirects, heredocs,
   globs, vars), a pre-warmed bash process runs the command via a marker protocol, is
   killed after one use (no cross-call cwd/env leakage — the safety model the
   fresh-spawn design chose), and a replacement is warmed in the background. State
   never persists between calls, so the "bash permanently broken after a killed
   background task" failure mode (Anthropic #62978) cannot occur.
3. **Fallback** — `createLocalBashOperations().exec`, i.e. today's exact path.

Any protocol failure (no marker, `exec`/`exit` replaced the shell, watchdog) falls
through to the fallback. Worst case = today's behaviour.

## Edge cases handled

| Case | Behaviour |
|---|---|
| Parallel bash calls (one turn) | A single shared pool accelerates calls while idle workers are available. Overflow calls immediately use the normal fresh-spawn fallback; they never queue behind the warm idle target, so the pool cannot become a hidden concurrency cap. |
| Backgrounded jobs (`cmd &`) | On normal completion kill **only the bash PID** (children orphan-and-survive, matching today); kill-tree only on timeout/abort. |
| Heredocs (`<<EOF`) | `</dev/null` is safe (heredoc is a per-command redirect that takes precedence). |
| `exec`/`exit` replacing the shell | process-close race path uses the real exit code. |
| Commands that read stdin (`cat`, REPLs) | `</dev/null` prevents them eating the marker. |
| Marker collision with output | Random per-call token; astronomically unlikely. |
| Timeout / abort | Kill-tree the worker, spawn a replacement; throw `timeout:N` / `aborted` (propagated, matching the built-in). |
| Worker dies while idle | Detected on next run; caller falls back to a fresh spawn. |

## Config (env vars)

| Var | Default | Meaning |
|---|---|---|
| `PIE_BASH_WARM_POOL` | `2` | Idle target for the single shared warm pool — the number of bash processes kept warm across ALL sessions. Dynamically spawns up to the target and kills excess idle when lowered. `0` = disabled (today's behaviour). |
| `PIE_BASH_FAST_PATH` | `1` | `1`/`0` — enable the execFile fast path. |
| `PIE_BASH_AUTO_PRUNE` | `1` | `1`/`0` — transparently inject `--exclude-dir` / `-prune` into recursive `grep` / bare-path `find` so bash-embedded search skips node_modules/.git (approximates rg; gated by a runtime GNU-grep probe). `0` = skip the rewrite entirely. |
| `PIE_SHELL` | auto | Explicit bash path (default: auto-detect Git Bash / bash). |
| `PIE_BASH_WARMUP_TIMEOUT_MS` | `10000` | Time allowed for a newly spawned worker to print its ready marker. `0` uses the default. |
| `PIE_BASH_DEFAULT_TIMEOUT` | `60` | Default command timeout in seconds when a call does not specify one (maximum `600`). |

The pool is a single **shared** pool (one process-wide, NOT per-session) — workers
are single-use (used once then killed, re-cd'd per command) so sharing across
sessions never reintroduces cross-call cwd/env leakage. It is created on first
use, lives for the process lifetime (it is NOT disposed on `session_shutdown` —
only per-session tool/metrics state is dropped), and is disposed only when the
idle target is set to 0 or the process exits. Shell or warmup-timeout changes
replace the shared pool and increment a process-wide generation; cached tools in
all extension instances adopt the replacement lazily on their next call.

## Why not just a persistent shell?

Codex and the Anthropic API keep the shell alive to *preserve state* (cwd, env,
background jobs). This extension preserves pi's existing **no-state** model (fresh
spawn per call) and only hides the spawn latency — so it gets the speedup without
introducing state-leakage bugs. See `scripts/analyze-bash.mjs` for the command-mix
analysis that motivated this (84.6% of bash calls need a shell; the fast path covers
the no-metacharacter share, the warm pool covers the rest).
