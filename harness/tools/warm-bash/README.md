# warm-bash

Can reduce `bash` tool response latency by preparing shells ahead of demand.
Shell-startup cost and the benefit of prewarming depend on the environment.

Replaces the built-in `bash` tool with a layered executor whose final fallback is
`createLocalBashOperations().exec`. The built-in rendering (streaming,
truncation, "Took Xs") is inherited.

## How it works (per `bash` call)

1. **Fast path** — `execFile` for simple commands (one program + args, no shell
   metacharacters). **No bash.exe is spawned at all.** Windows `.cmd`/`.bat` shims
   (`npm`, `npx`, …) are resolved on PATH so they fast-path too. `echo` with no flags
   is served in-process (zero spawn) — it's the most common agent "command".
2. **Warm bash** — for commands that need a shell (pipes, `&&`, redirects, heredocs,
   globs, vars), a pre-warmed bash process runs the command via a marker protocol, is
   killed after one use, and a replacement is warmed in the background. Shell
   cwd/env mutations are not reused by later commands.
3. **Fallback** — `createLocalBashOperations().exec`, i.e. today's exact path.

An unavailable worker or a `WarmExecError` falls through to the fresh-spawn
fallback. Timeout and abort errors propagate instead; `exec`/`exit` normally use
the shell's exit code. Fallback adds overhead, and retrying after a protocol
failure that occurred after execution began can repeat side effects. This is not
an unconditional latency or semantic-equivalence guarantee.

Prewarming moves startup work off the response path; it does not demonstrate
lower CPU use. Each warm hit consumes a shell and triggers replenishment, adding
spawn, marker and cleanup work. Including replenishment can erase the response
latency benefit or make a full cycle slower than fresh spawn.

## Managed and project-aware PATH semantics

`warm-bash` derives child-process environments; it does not impose global
`PATH` changes. [`sanitizeProtoEnv`](./managed-env.ts) returns a copy that
removes inherited proto tool-version/shim pins and direct
`$PROTO_HOME/tools/...` PATH entries, so pinned installs cannot bypass
project-aware shims. It places `$PROTO_HOME/shims` (then `$PROTO_HOME/bin`)
immediately after pi's managed `<agentDir>/bin` when that entry is on `PATH`,
preserving priority for managed SDK tools such as `rg`/`fd`; otherwise the proto
entries go at the front. The shims can then resolve tool versions from
the current project's `.prototools` instead of a frozen inherited activation.

This sanitization is used for the shared warm-pool environment and per-call
environments used by the fast and fallback paths. Warm workers retain their
creation-time environment; per-call environment overrides are not applied to them.

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
| `PIE_BASH_WARM_POOL` | `2` | Idle target for the shared pool within one Node process, not across separate session-worker processes. Dynamically spawns up to the target and kills excess idle when lowered. `0` = warm pool disabled. |
| `PIE_BASH_FAST_PATH` | `1` | `1`/`0` — enable the execFile fast path. |
| `PIE_BASH_AUTO_PRUNE` | `1` | `1`/`0` — transparently applies the [canonical traversal-safety policy](../execution-safety/traversal-policy.ts) to recursive bash searches: recursive `grep` receives ONLY the `--exclude-dir` flags it is missing (existing ones are never duplicated; byte-identical passthrough when nothing is missing) and bare-path `find` gets the full `-prune` expression — approximates rg and is gated by a runtime GNU-grep probe. Unsupported bare-root walkers with no safe prune mechanism — recursive `ls -R`/`ls --recursive`, `tree`, and `du` (path absent, `.`, or root `*`) — are rewritten to a bounded fail-fast rejection (explanatory stderr message + exit 2) instead of traversing multi-gigabyte trees. Exact/scoped inspection (`ls -R src`, `tree data`, `du sessions`) and the explicit `PIE_BASH_AUTO_PRUNE=0` assignment prefix pass through; unrelated assignments do not disable the guard. `0` = skip all rewrites. |
| `PIE_SHELL` | auto | Explicit bash path (default: auto-detect Git Bash / bash). |
| `PIE_BASH_WARMUP_TIMEOUT_MS` | `10000` | Time allowed for a newly spawned worker to print its ready marker. `0` uses the default. |
| `PIE_BASH_DEFAULT_TIMEOUT` | `60` | Default command timeout in seconds when a call does not specify one (maximum `600`). |

On Windows, an auto-detected Git Bash uses Git's real `usr/bin/bash.exe`
directly instead of the extra `bin/bash.exe` launcher process. An explicit
`PIE_SHELL` is always respected unchanged.

The pool is **process-local**: extension instances in the same Node process
share it, but separate session-worker processes have separate pools. With the
default target, N processes can retain roughly 2N idle shells, plus warming,
busy and fallback processes. Workers are single-use and re-cd'd per command.
It starts warming at extension activation so the first bash call can hit the
pool, then lives for the
process lifetime (it is NOT disposed on `session_shutdown` — only per-session
tool/metrics state is dropped), and is disposed only when the idle target is set
to 0 or the process exits. Shell or warmup-timeout changes
replace the shared pool and increment a process-wide generation; cached tools in
all extension instances adopt the replacement lazily on their next call.

## Why not just a persistent shell?

Codex and the Anthropic API keep the shell alive to *preserve state* (cwd, env,
background jobs). This extension preserves pi's existing **no-state** model (fresh
spawn per call) by using each warm shell once, aiming to hide startup latency
rather than preserve shell state. See `scripts/diagnostics/analyze-bash.mjs` for the command-mix
analysis that motivated this (84.6% of bash calls need a shell; the fast path covers
the no-metacharacter share, the warm pool covers the rest).
