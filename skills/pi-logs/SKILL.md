---
name: pi-logs
description: Read and interface with pie (pi coding agent) logs — the /debug snapshot, session JSONL history, and truncated tool-output temp logs. Groups identical log lines Unity-style (collapsing repeats into counts) for compact agent review, with optional volatile-token normalization. Use when the user asks to inspect pi logs, review what a session did, debug the TUI, find a truncated command's full output, see what was sent to the LLM, or read any large/repetitive log file.
---

# Pi Logs

Pi emits three distinct logs. This skill reads and groups them. Script paths below
(e.g. `pi-logs/pi_logs.py`) are relative to the skill directory; run with `uv run`.

**No install step** — the script is stdlib-only Python. `uv run` bootstraps Python
automatically. If `uv` is unavailable, `python3 pi-logs/pi_logs.py ...` works too.
Run any subcommand with `--help` for full options.

## The three pi logs

| Kind | Path | Written by | What it contains | Read when |
|---|---|---|---|---|
| **Debug** | `~/.pi/agent/pi-debug.log` | the `/debug` command (hidden) | A snapshot: every rendered TUI line (ANSI, JSON-escaped, with visible widths) **and** the agent messages last sent to the LLM | The TUI looks wrong, something didn't render, "what did the model actually get sent" |
| **Session** | `~/.pi/agent/sessions/--<cwd>--/*.jsonl` | pi continuously | Persistent tree-structured conversation history (messages, tool calls, model changes, compactions, branches) | "What did that session do", auditing tool calls/cost, replaying a flow, debugging an agent run |
| **Temp** | `$TMPDIR/pi-{bash,output}-<hex>.log` | pi, when a tool result is truncated | The full untruncated output of a bash command or tool (referenced in messages as `Full output: …`) | A bash/tool result was truncated and you need the full output; also: these are never auto-cleaned — see `temp --list` |

The debug log is a **snapshot** (overwritten each `/debug`), not a live stream.
Session JSONL is the durable record. Temp logs are orphans pi leaves in the system
tmpdir — re-read them before the OS reaps them.

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
uv run pi-logs/pi_logs.py summary
```

### debug — read the /debug snapshot

```bash
uv run pi-logs/pi_logs.py debug                          # both sections, grouped
uv run pi-logs/pi_logs.py debug --section lines           # rendered TUI lines only
uv run pi-logs/pi_logs.py debug --section messages        # agent messages only
uv run pi-logs/pi_logs.py debug --filter "error" --top 50 # filter by regex
uv run pi-logs/pi_logs.py debug --no-ansi                 # keep ANSI in grouping key
uv run pi-logs/pi_logs.py debug --normalize smart         # collapse timestamps/ids
uv run pi-logs/pi_logs.py debug --grouped                 # group message text too
```

If absent: tell the user to run `/debug` in pi, then re-run.

### session — read session JSONL

```bash
uv run pi-logs/pi_logs.py session                         # most recent (for current cwd)
uv run pi-logs/pi_logs.py session <path>                  # explicit file
uv run pi-logs/pi_logs.py session --summary               # overview: types/roles/tools/tokens/cost
uv run pi-logs/pi_logs.py session --context               # walk current leaf→root (the LLM context)
uv run pi-logs/pi_logs.py session --role assistant        # filter by message role
uv run pi-logs/pi_logs.py session --type model_change     # filter by entry type
uv run pi-logs/pi_logs.py session --tool bash             # filter by tool name
uv run pi-logs/pi_logs.py session --errors                # only errors / failed tool results
uv run pi-logs/pi_logs.py session --grouped               # group identical message text
uv run pi-logs/pi_logs.py session --last 20               # limit to last N entries
uv run pi-logs/pi_logs.py session --cwd /some/project     # pick session for a different cwd
```

Entry types: `session`, `message`, `model_change`, `thinking_level_change`, `compaction`,
`branch_summary`, `custom`, `custom_message`, `label`, `session_info`.
Message roles: `user`, `assistant`, `toolResult`, `bashExecution`, `custom`, `branchSummary`, `compactionSummary`.

### group — Unity-group ANY file

```bash
uv run pi-logs/pi_logs.py group <file>                    # exact grouping
uv run pi-logs/pi_logs.py group <file> --normalize smart  # collapse volatile tokens
uv run pi-logs/pi_logs.py group <file> --top 100 --min 3  # busy files
uv run pi-logs/pi_logs.py group <file> --no-ansi          # raw escape sequences
uv run pi-logs/pi_logs.py group <file> --context         # show line ranges
```

### temp — tool-output temp logs

```bash
uv run pi-logs/pi_logs.py temp --list                     # all pi-*.log in tmpdir (default)
uv run pi-logs/pi_logs.py temp --read <name-or-path>      # grouped summary + tail
uv run pi-logs/pi_logs.py temp --grouped <name-or-path>  # grouped only (full)
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
- **Temp log lifecycle**: pi does not delete them. They accumulate until the OS tmpdir
  is cleaned. Don't rely on them for long-term audit — copy a needed one elsewhere.
- **Token/cost** are summed from `assistant` message `usage`; messages without `usage`
  (custom, compaction summaries) contribute nothing.
