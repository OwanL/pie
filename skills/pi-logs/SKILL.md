---
name: pi-logs
description: Inspect and group pie debug, session, and truncated-tool logs. Use when debugging pie runtime/TUI behavior, auditing what a model received or did, or recovering full tool output; not for general application logging.
---

# Pi Logs

Pi emits three distinct logs. This skill reads and groups them.

**Invocation:** resolve `pi_logs.py` against this skill directory and invoke that
absolute path. Do not assume the session cwd contains the script.

```bash
python "<skill-directory>/pi_logs.py" summary
# Equivalent when uv is preferred:
uv run "<skill-directory>/pi_logs.py" summary
```

The script is stdlib-only, so there is no install step. Use `python3` instead of
`python` where that is the available executable. Run any subcommand with
`--help` before guessing at options.

## The three pi logs

| Kind | Path | Written by | What it contains | Read when |
|---|---|---|---|---|
| **Debug** | `~/.pi/agent/pi-debug.log` | the `/debug` command (hidden) | A snapshot: every rendered TUI line (ANSI, JSON-escaped, with visible widths) **and** the agent messages last sent to the LLM | The TUI looks wrong, something didn't render, "what did the model actually get sent" |
| **Session** | `~/.pi/agent/sessions/--<cwd>--/*.jsonl` | pi continuously | Persistent tree-structured conversation history (messages, tool calls, model changes, compactions, branches) | "What did that session do", auditing tool calls/cost, replaying a flow, debugging an agent run |
| **Temp** | `$TMPDIR/pi-{bash,output}-<hex>.log` | pi, when a tool result is truncated | The full untruncated output of a bash command or tool (referenced in messages as `Full output: …`) | A bash/tool result was truncated and you need the full output; also: these are never auto-cleaned — see `temp --list` |

The debug log is a **snapshot** (overwritten each `/debug`), not a live stream.
Session JSONL is the durable record. Temp logs are written to the system tmpdir
and reaped at extension activation (see Notes & gotchas) — re-read a needed one
promptly.

## Unity-style grouping (the headline)

Raw logs are huge and repetitive. This skill collapses identical lines into one entry
with a count badge — like Unity's console. 1500 rendered TUI lines become ~300 unique
groups; the chrome (borders, spacers, status lines) jumps to the top by repeat count,
leaving the real signal visible.

- **Exact grouping** (default): lines identical after ANSI-strip + rstrip collapse.
- **`--normalize smart`**: additionally replaces timestamps, UUIDs, hex IDs, and integers
  with placeholders before grouping — so `Error at 10:00:00 line 42` and
  `Error at 11:30:00 line 87` collapse to one group `x2`. Use this when noisy volatile
  tokens are splitting an obvious pattern into many tiny groups.
- **`--normalize '<regex>'`**: custom — every regex match becomes `<*>` in the grouping key.
- **`--context`**: show the first/last line index of each group (where it occurs).
- **`--top N`** / **`--min N`**: cap output and hide rare groups.

Grouping applies to **any file** via the `group` subcommand — not just pi logs.

## Commands

Always start with `summary` to see what exists and where:

```bash
python "<skill-directory>/pi_logs.py" summary
```

### debug — read the /debug snapshot

```bash
python "<skill-directory>/pi_logs.py" debug                          # both sections, grouped
python "<skill-directory>/pi_logs.py" debug --section lines           # rendered TUI lines only
python "<skill-directory>/pi_logs.py" debug --section messages        # agent messages only
python "<skill-directory>/pi_logs.py" debug --filter "error" --top 50 # filter by regex
python "<skill-directory>/pi_logs.py" debug --no-ansi                 # keep ANSI in grouping key
python "<skill-directory>/pi_logs.py" debug --normalize smart         # collapse timestamps/ids
python "<skill-directory>/pi_logs.py" debug --grouped                 # group message text too
```

If absent: tell the user to run `/debug` in pi, then re-run.

### session — read session JSONL

```bash
python "<skill-directory>/pi_logs.py" session                         # most recent (for current cwd)
python "<skill-directory>/pi_logs.py" session <path>                  # explicit file
python "<skill-directory>/pi_logs.py" session --summary               # overview: types/roles/tools/tokens/cost
python "<skill-directory>/pi_logs.py" session --context               # walk current leaf→root (the LLM context)
python "<skill-directory>/pi_logs.py" session --role assistant        # filter by message role
python "<skill-directory>/pi_logs.py" session --type model_change     # filter by entry type
python "<skill-directory>/pi_logs.py" session --tool bash             # filter by tool name
python "<skill-directory>/pi_logs.py" session --errors                # only errors / failed tool results
python "<skill-directory>/pi_logs.py" session --grouped               # group identical message text
python "<skill-directory>/pi_logs.py" session --last 20               # limit to last N entries
python "<skill-directory>/pi_logs.py" session --cwd /some/project     # pick session for a different cwd
```

**Session directory resolution:** `summary` and `session` read the canonical
sessions directory only, resolved in this order: (1) `--sessions-dir <path>`
flag; (2) `sessionDir` from `settings.json` (resolved relative to the settings
file — e.g. `data/outcomes/sessions`); (3) `~/.pi/agent/sessions` (pi's SDK
default, only when `sessionDir` is unset). The runtime no longer scans legacy
roots — if a session is missing here, run `npm run doctor` to detect sessions
stranded in a legacy root without a canonical counterpart, then re-run the
installer to migrate them. Pass `--sessions-dir` to point at a different store.

Entry types: `session`, `message`, `model_change`, `thinking_level_change`, `compaction`,
`branch_summary`, `custom`, `custom_message`, `label`, `session_info`.
Message roles: `user`, `assistant`, `toolResult`, `bashExecution`, `custom`, `branchSummary`, `compactionSummary`.

### group — Unity-group ANY file

```bash
python "<skill-directory>/pi_logs.py" group <file>                    # exact grouping
python "<skill-directory>/pi_logs.py" group <file> --filter "error"   # matching lines only
python "<skill-directory>/pi_logs.py" group <file> --normalize smart  # collapse volatile tokens
python "<skill-directory>/pi_logs.py" group <file> --top 100 --min 3  # busy files
python "<skill-directory>/pi_logs.py" group <file> --no-ansi          # raw escape sequences
python "<skill-directory>/pi_logs.py" group <file> --context          # show line ranges
```

`group --filter` filters first and then groups. It accepts relative, absolute,
and bare temp-log names. On Windows it also translates Git Bash `/tmp/...`
paths to the native temp directory; `pie.log` resolves from the usual
`<temp>/pie-logs` location when unambiguous.

### temp — tool-output temp logs

```bash
python "<skill-directory>/pi_logs.py" temp --list                    # all pi-*.log in tmpdir (default)
python "<skill-directory>/pi_logs.py" temp --read <name-or-path>     # grouped summary + tail
python "<skill-directory>/pi_logs.py" temp --grouped <name-or-path> # grouped only (full)
```

`--read` accepts a bare filename (resolved in the tmpdir). Output is grouped first
(repeats surfaced), then a 40-line tail for recency.

## Decision guide

| User intent | Command |
|---|---|
| "What pi logs exist?" | `summary` |
| "The TUI looks wrong / didn't render" | `debug --section lines` (ensure a fresh `/debug` first) |
| "What was actually sent to the LLM?" | `debug --section messages` |
| "What did that session do?" | `session --summary`, then `session` for detail |
| "Show only the errors" | `session --errors` |
| "What tools ran / how much did it cost?" | `session --summary` |
| "What's in the model's context right now?" | `session --context` |
| "The bash output was truncated" | `temp --list`, then `temp --read <name>` |
| "This log is huge and noisy" | `group <file> --normalize smart --top 50` |
| "Find the repeated failures in a build log" | `group <file> --min 3` |

## Agent-native output

All commands print dense, line-oriented text: counts and summaries first, details
capped (`--top`), volatile tokens optional. Parse the badges (`x<count>`) and section
headers (`=== … ===`) rather than free text. Errors and diagnostics go to stderr; data
goes to stdout. If a section prints `… N more unique group(s)`, raise `--top` to see them.

## Notes & gotchas

- **Debug log freshness**: it's a point-in-time snapshot. Re-run `/debug` in pi before
  re-reading if the state has moved on.
- **Session cwd encoding**: pi turns `c:\Users\me\proj` into `--c--Users-me-proj--`
  (each `/`, `\`, `:` → `-`, wrapped in `--`/`--`). The `--cwd` flag handles this; if a
  session isn't found for the current cwd, `session` falls back to the newest overall
  (it prints `using session: …` to stderr — check that path's cwd matches).
- **Mixed Windows/Git Bash paths**: prefer the path printed by `summary`, but
  `/tmp/...` and bare temp-log names are accepted even when the script runs
  under native Windows Python. Do not manually translate them first.
- **Temp log lifecycle**: pi reaps orphaned temp logs (`pi-bash-*` / `pi-output-*`)
  at extension activation via a best-effort reaper
  (`extension/src/host/util/temp-log-reaper.ts`). Retention is configurable via
  the `pie.tempLogRetention` setting (`maxAgeDays` default 7, `maxTotalSizeMb`
  default 500): files older than the age cutoff are deleted first, then oldest
  survivors are evicted until the total is under the size cap. Recent logs you
  may still need are kept; don't rely on temp logs for long-term audit — copy a
  needed one elsewhere.
- **Token/cost** are summed from `assistant` message `usage`; messages without `usage`
  (custom, compaction summaries) contribute nothing.
