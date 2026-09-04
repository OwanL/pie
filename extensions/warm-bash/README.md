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

## Managed-bin PATH semantics

pi prepends its managed SDK binary directory (`<agentDir>/bin`, holding `rg`/`fd`)
to `PATH` via `getShellEnv()` so those binaries resolve ahead of the inherited
PATH. warm-bash preserves this at every layer:

- **Warm pool** — the shared `WarmBashPool` is spawned with that authoritative
  managed env (derived by prepending `join(getAgentDir(), "bin")` to the
  platform PATH key), so warm workers resolve `rg`/`fd`.
- **Fast path** — the resolver scans the per-call execution env's `PATH` (not
  `process.env.PATH`) and caches per (program, PATH), so managed binaries
  fast-path too.
- **Fallback** — already uses pi's `getShellEnv()`.

No layer is worse than the built-in fresh-spawn path for managed binaries.

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
| `PIE_BASH_AUTO_PRUNE` | `1` | `1`/`0` — transparently applies the canonical traversal-safety policy (`shared/traversal-policy.ts`: dependencies, generated/build, caches, coverage, runtime data, sessions, logs, packaged artifacts, temp SDK trees) to recursive bash searches: recursive `grep` receives ONLY the `--exclude-dir` flags it is missing (existing ones are never duplicated; byte-identical passthrough when nothing is missing) and bare-path `find` gets the full `-prune` expression — approximates rg and is gated by a runtime GNU-grep probe. Unsupported bare-root walkers with no safe prune mechanism — recursive `ls -R`/`ls --recursive`, `tree`, and `du` (path absent, `.`, or root `*`) — are rewritten to a bounded fail-fast rejection (explanatory stderr message + exit 2) instead of traversing multi-gigabyte trees. Exact/scoped inspection (`ls -R src`, `tree data`, `du sessions`) and the explicit `PIE_BASH_AUTO_PRUNE=0` assignment prefix pass through; unrelated assignments do not disable the guard. `0` = skip all rewrites. |
| `PIE_SHELL` | auto | Explicit bash path (default: auto-detect Git Bash / bash). |
| `PIE_BASH_WARMUP_TIMEOUT_MS` | `10000` | Time allowed for a newly spawned worker to print its ready marker. `0` uses the default. |
| `PIE_BASH_DEFAULT_TIMEOUT` | `60` | Default command timeout in seconds when a call does not specify one (maximum `600`). |

On Windows, an auto-detected Git Bash uses Git's real `usr/bin/bash.exe`
directly instead of the extra `bin/bash.exe` launcher process. An explicit
`PIE_SHELL` is always respected unchanged.

The pool is a single **shared** pool (one process-wide, NOT per-session) — workers
are single-use (used once then killed, re-cd'd per command) so sharing across
sessions never reintroduces cross-call cwd/env leakage. It starts warming at
extension activation so the first bash call can hit the pool, then lives for the
process lifetime (it is NOT disposed on `session_shutdown` — only per-session
tool/metrics state is dropped), and is disposed only when the idle target is set
to 0 or the process exits. Shell or warmup-timeout changes
replace the shared pool and increment a process-wide generation; cached tools in
all extension instances adopt the replacement lazily on their next call.

## Why not just a persistent shell?

Codex and the Anthropic API keep the shell alive to *preserve state* (cwd, env,
background jobs). This extension preserves pi's existing **no-state** model (fresh
spawn per call) and only hides the spawn latency — so it gets the speedup without
introducing state-leakage bugs. See `scripts/analyze-bash.mjs` for the command-mix
analysis that motivated this (84.6% of bash calls need a shell; the fast path covers
the no-metacharacter share, the warm pool covers the rest).
