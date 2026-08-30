---
name: pie-logs
description: Inspect and group Pie persistent, debug, session, and truncated-tool logs. Use when debugging Pie extension/runtime/TUI behavior, auditing what a model received or did, or recovering full tool output; not for unrelated application logging.
---

# Pie Logs

Pie emits four distinct log kinds. This skill reads and groups them.

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

## The four Pie log kinds

| Kind | Path | Written by | What it contains | Read when |
|---|---|---|---|---|
| **Persistent** | `<system-tmp>/pie-logs/pie.log` and rotated `pie.log.1` | Pie's VS Code extension | Durable extension, backend, worker, and forwarded webview diagnostics | Pie behavior fails outside one TUI snapshot, or current diagnostics may have rotated |
| **Debug** | `$PI_CODING_AGENT_DIR/pi-debug.log` (SDK default `~/.pi/agent/pi-debug.log`) | the `/debug` command (hidden) | A snapshot: every rendered TUI line (ANSI, JSON-escaped, with visible widths) **and** the agent messages last sent to the LLM | The TUI looks wrong, something didn't render, "what did the model actually get sent" |
| **Session** | the resolved canonical session store | pi continuously | Persistent tree-structured conversation history (messages, tool calls, model changes, history compactions, branches) | "What did that session do", auditing tool calls/cost, replaying a flow, debugging an agent run |
| **Temp** | `<system-tmp>/pi-{bash,output}-<hex>.log` | pi, when a tool result is truncated | The full untruncated output of a bash command or tool (referenced in messages as `Full output: …`) | A bash/tool result was truncated and you need the full output before retention cleanup removes it |

The debug log is a **snapshot** (overwritten each `/debug`), not a live stream.
Session JSONL and the bounded persistent logs are durable diagnostics. Truncated
output logs are temporary and subject to retention cleanup at extension activation
(see Notes & gotchas), so copy a needed one promptly.

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

Grouping applies to **any file** via the `group` subcommand — not just Pie logs.

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
python "<skill-directory>/pi_logs.py" session --context               # SDK-parity active branch with history compaction applied
python "<skill-directory>/pi_logs.py" session --role assistant        # filter by message role
python "<skill-directory>/pi_logs.py" session --type model_change     # filter by entry type
python "<skill-directory>/pi_logs.py" session --tool bash             # filter by tool name
python "<skill-directory>/pi_logs.py" session --errors                # only errors / failed tool results
python "<skill-directory>/pi_logs.py" session --grouped               # group identical message text
python "<skill-directory>/pi_logs.py" session --last 20               # limit to last N entries
python "<skill-directory>/pi_logs.py" session --cwd /some/project     # pick session for a different cwd
```

**Session directory resolution:** `summary` and `session` read the canonical
session store only, resolved in this order: (1) `--sessions-dir <path>`;
(2) `PI_CODING_AGENT_SESSION_DIR`; (3) `sessionDir` from
`$PI_CODING_AGENT_DIR/settings.json` (SDK default `~/.pi/agent/settings.json`,
with relative values resolved from that file); (4) `$PI_CODING_AGENT_DIR/sessions`
(the SDK default). The runtime no longer scans legacy roots — if a session is
missing here, run `npm run doctor` to detect sessions stranded in a legacy root
without a canonical counterpart, then re-run the installer to migrate them.

Entry types: `session`, `message`, `model_change`, `thinking_level_change`, `compaction`,
`branch_summary`, `custom`, `custom_message`, `label`, `session_info`.
Message roles: `user`, `assistant`, `toolResult`, `bashExecution`, `custom`, `branchSummary`, `compactionSummary`.

`session --context` matches the pinned SDK's `buildContextEntries`: it follows
the branch ending at the latest entry and, when history compaction exists on that
branch, emits the latest compaction entry, its kept range, and entries after it.
Older summarized entries and entries on other branches are omitted.

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
| "What Pie logs exist?" | `summary` |
| "What failed in the extension/backend/webview?" | `group pie.log`; inspect `group pie.log.1` if the event may have rotated |
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
- **Session cwd selection**: `--cwd` normalizes the requested path and compares it
  with each session header's `cwd` across the canonical store; it does not trust the
  containing directory's encoded name. If none matches, the command fails rather than
  silently selecting an unrelated session. A positional session path remains explicit
  and is opened as given, regardless of `--cwd`.
- **Mixed Windows/Git Bash paths**: prefer the path printed by `summary`, but
  `/tmp/...` and bare temp-log names are accepted even when the script runs
  under native Windows Python. Do not manually translate them first.
- **Truncated-output temp lifecycle**: Pie applies retention cleanup to orphaned
  temp logs (`pi-bash-*` / `pi-output-*`) at extension activation via a best-effort reaper
  (`extension/src/host/util/temp-log-reaper.ts`). Retention is configurable via
  the `pie.tempLogRetention` setting (`maxAgeDays` default 7, `maxTotalSizeMb`
  default 500): files older than the age cutoff are deleted first, then oldest
  survivors are evicted until the total is under the size cap. Recent logs you
  may still need are kept; don't rely on temp logs for long-term audit — copy a
  needed one elsewhere.
- **Token/cost** are summed from `assistant` message `usage`; messages without `usage`
  (custom, compaction summaries) contribute nothing.
