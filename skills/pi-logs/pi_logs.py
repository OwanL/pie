#!/usr/bin/env python3
"""
pi_logs.py — read and interface with pie (pi coding agent) logs.

Three kinds of pi logs:
  1. Debug log      ~/.pi/agent/pi-debug.log              (snapshot written by /debug)
  2. Session JSONL  ~/.pi/agent/sessions/<dir>/*.jsonl   (persistent conversation history)
  3. Tool temp      $TMPDIR/pi-{bash,output}-<hex>.log   (full output of truncated tool results)

Unity-style grouping collapses repeated lines into one entry with a count, turning
thousands of log lines into a small set of unique signals — ideal for agent review.

Usage:
    uv run pi_logs.py summary
    uv run pi_logs.py debug    [--section lines|messages] [--top N] [--filter REGEX] [--no-ansi] [--normalize smart]
    uv run pi_logs.py session  [PATH] [--summary] [--role R] [--type T] [--tool NAME] [--errors]
                               [--grouped] [--last N] [--context] [--cwd DIR]
    uv run pi_logs.py group FILE [--top N] [--min N] [--normalize REGEX] [--no-ansi] [--context]
    uv run pi_logs.py temp     [--list | --read PATH | --grouped PATH]

Run with no args -> `summary`. Any subcommand accepts --help.
Stdlib only — no install step. Fallback: `python3 pi_logs.py ...`.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

# Force UTF-8 stdout/stderr so agent-consumed bytes are correct regardless of
# the host console codepage (Windows conhost defaults to cp1252).
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

HOME = Path(os.path.expanduser("~"))
AGENT_DIR = HOME / ".pi" / "agent"
DEBUG_LOG = AGENT_DIR / "pi-debug.log"
SESSIONS_DIR = AGENT_DIR / "sessions"
TMP_DIR = Path(os.environ.get("TMPDIR") or os.environ.get("TEMP") or os.environ.get("TMP") or "/tmp")

# Debug log section markers
RENDERED_HEADER = "=== All rendered lines with visible widths ==="
MESSAGES_HEADER = "=== Agent messages (JSONL) ==="

# Regex matching a debug-log rendered line:  [idx] (w=N) "json string"
_DEBUG_LINE_RE = re.compile(r'^\[(\d+)\]\s\(w=(\d+)\)\s(.*)$')

# CSI + OSC + other ANSI escape sequences
_ANSI_RE = re.compile(r"""
    \x1b\[[0-9;?]*[ -/]*[@-~]        # CSI sequences
  | \x1b\][^\x07\x1b]*(?:\x07|\x1b\\) # OSC sequences
  | \x1b[@-Z\\-_]                     # 2-char escapes
  | \x1b[()*+][0-9A-Za-z]             # charset designators
""", re.VERBOSE)

# Volatile-token patterns for --normalize smart (opt-in via --normalize smart)
_SMART_PATTERNS: list[tuple[str, str]] = [
    (r'\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b', '<ts>'),
    (r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b', '<uuid>'),
    (r'\b[0-9a-f]{8,16}\b', '<hex>'),
    (r'\b\d+\b', '<n>'),
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def strip_ansi(s: str) -> str:
    """Remove ANSI escape sequences and leftover render artifacts."""
    s = _ANSI_RE.sub("", s)
    # Collapse runs of whitespace? No — preserve structure; only rstrip lines later.
    return s


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def fmt_age(mtime: float) -> str:
    delta = datetime.now().timestamp() - mtime
    if delta < 60:
        return f"{int(delta)}s ago"
    if delta < 3600:
        return f"{int(delta // 60)}m ago"
    if delta < 86400:
        return f"{int(delta // 3600)}h ago"
    return f"{int(delta // 86400)}d ago"


def iso_local(mtime: float) -> str:
    return datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S")


def eprint(*args, **kwargs) -> None:
    print(*args, file=sys.stderr, **kwargs)


# ---------------------------------------------------------------------------
# Unity-style grouping
# ---------------------------------------------------------------------------

@dataclass
class Group:
    count: int
    key: str          # normalized key used for dedup
    sample: str       # original sample line for display
    first_idx: int    # 0-based line index of first occurrence
    last_idx: int


def build_normalizer(normalize: str | None):
    """Return a function mapping a line to its grouping key."""
    if not normalize:
        return lambda line: line

    if normalize == "smart":
        compiled = [(re.compile(p), r) for p, r in _SMART_PATTERNS]

        def smart(line: str) -> str:
            for rx, repl in compiled:
                line = rx.sub(repl, line)
            return line
        return smart

    # Treat normalize as a regex; matching spans replaced with '<*>'.
    try:
        rx = re.compile(normalize)
    except re.error as exc:
        eprint(f"error: invalid --normalize regex: {exc}")
        sys.exit(2)

    return lambda line: rx.sub("<*>", line)


def group_lines(
    lines: list[str],
    *,
    strip_ansi_flag: bool,
    normalize: str | None,
) -> list[Group]:
    """
    Group lines Unity-style.

    - Empty lines collapse into one group keyed as ''.
    - Lines are grouped by normalized key (exact by default; --normalize collapses
      volatile tokens).
    - Returns groups sorted by count desc, then first_idx asc (stable, readable).
    """
    key_fn = build_normalizer(normalize)
    groups: dict[str, Group] = {}

    for idx, raw in enumerate(lines):
        line = raw.rstrip("\n").rstrip("\r")
        if strip_ansi_flag:
            line = strip_ansi(line)
        display = line.rstrip()
        key = key_fn(display)
        existing = groups.get(key)
        if existing is None:
            groups[key] = Group(count=1, key=key, sample=display, first_idx=idx, last_idx=idx)
        else:
            existing.count += 1
            existing.last_idx = idx

    return sorted(groups.values(), key=lambda g: (-g.count, g.first_idx))


def render_groups(
    groups: list[Group],
    *,
    top: int,
    min_count: int,
    context: bool,
    total: int,
    unique: int,
) -> list[str]:
    out: list[str] = []
    shown = 0
    for g in groups:
        if g.count < min_count:
            continue
        if shown >= top:
            break
        if context:
            loc = f"  L{g.first_idx + 1}" if g.first_idx == g.last_idx else f"  L{g.first_idx + 1}-{g.last_idx + 1}"
        else:
            loc = ""
        badge = "" if g.count == 1 else f"x{g.count} "
        sample = g.sample if len(g.sample) <= 200 else g.sample[:197] + "..."
        out.append(f"  {badge:<6}{sample}{loc}" if badge else f"  {sample}{loc}")
        shown += 1
    hidden = unique - shown
    footer = f"  ... {hidden} more unique group(s)" if hidden > 0 else ""
    if footer:
        out.append(footer)
    return out


# ---------------------------------------------------------------------------
# Debug log parsing
# ---------------------------------------------------------------------------

@dataclass
class DebugLog:
    path: Path
    exists: bool
    written_at: str | None = None
    terminal: str | None = None
    total_lines: int | None = None
    rendered: list[tuple[int, int, str]] = field(default_factory=list)   # (idx, vw, raw_line)
    messages: list[dict] = field(default_factory=list)
    error: str | None = None


def parse_debug_log(path: Path) -> DebugLog:
    dl = DebugLog(path=path, exists=path.is_file())
    if not dl.exists:
        return dl
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        dl.error = str(exc)
        return dl

    lines = text.splitlines()
    section: str | None = None  # 'rendered' | 'messages'

    for line in lines:
        if line.startswith("Debug output at "):
            dl.written_at = line[len("Debug output at "):].strip()
            continue
        if line.startswith("Terminal: "):
            dl.terminal = line[len("Terminal: "):].strip()
            continue
        if line.startswith("Total lines: "):
            try:
                dl.total_lines = int(line[len("Total lines: "):].strip())
            except ValueError:
                pass
            continue
        if line == RENDERED_HEADER:
            section = "rendered"
            continue
        if line == MESSAGES_HEADER:
            section = "messages"
            continue
        if not line.strip():
            continue

        if section == "rendered":
            m = _DEBUG_LINE_RE.match(line)
            if m:
                idx = int(m.group(1))
                vw = int(m.group(2))
                payload = m.group(3).strip()
                raw = _unescape(payload)
                dl.rendered.append((idx, vw, raw))
        elif section == "messages":
            try:
                dl.messages.append(json.loads(line))
            except json.JSONDecodeError:
                # skip malformed
                pass

    return dl


def _unescape(payload: str) -> str:
    """Recover the real line from a JSON-escaped debug payload like `"\\u001b[1m..."`."""
    if not payload or payload[0] != '"':
        return payload
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        return payload


# ---------------------------------------------------------------------------
# Session JSONL parsing
# ---------------------------------------------------------------------------

@dataclass
class Session:
    path: Path
    header: dict | None
    entries: list[dict]
    error: str | None = None


def parse_session(path: Path) -> Session:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return Session(path=path, header=None, entries=[], error=str(exc))

    header: dict | None = None
    entries: list[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            continue
        if header is None:
            header = obj
            continue
        entries.append(obj)
    return Session(path=path, header=header, entries=entries)


def session_dir_for_cwd(cwd: str) -> Path | None:
    """
    Reverse pi's cwd->dir encoding: replace / \\ : with -, wrap in -- ... --.
    """
    encoded = "".join("-" if c in "/\\:" else c for c in cwd)
    candidate = SESSIONS_DIR / f"--{encoded}--"
    return candidate if candidate.is_dir() else None


def find_sessions(cwd: str | None = None) -> list[Path]:
    """All session .jsonl files under SESSIONS_DIR, newest first."""
    if not SESSIONS_DIR.is_dir():
        return []
    files = sorted(SESSIONS_DIR.rglob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    if cwd:
        target = session_dir_for_cwd(cwd)
        if target is not None:
            files = sorted(target.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    return files


def walk_leaf_to_root(entries: list[dict]) -> list[dict]:
    """Return entries from root to current leaf (the built context path)."""
    if not entries:
        return []
    by_id = {e.get("id"): e for e in entries if e.get("id")}
    # Leaf = entry whose id is not any other entry's parentId.
    parent_ids = {e.get("parentId") for e in entries if e.get("parentId")}
    leaves = [e for e in entries if e.get("id") and e.get("id") not in parent_ids]
    if not leaves:
        return list(entries)
    leaf = leaves[-1]
    chain: list[dict] = []
    cur: dict | None = leaf
    seen: set[str] = set()
    while cur is not None and cur.get("id") not in seen:
        seen.add(cur.get("id"))
        chain.append(cur)
        parent_id = cur.get("parentId")
        cur = by_id.get(parent_id) if parent_id else None
    chain.reverse()
    return chain


def message_role(msg: dict) -> str:
    return msg.get("role", "?")


def entry_type(entry: dict) -> str:
    return entry.get("type", "?")


def extract_text(msg: dict) -> str:
    """Best-effort flat text extraction from a message for display/grouping."""
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            t = block.get("type")
            if t == "text" and isinstance(block.get("text"), str):
                parts.append(block["text"])
            elif t == "thinking" and isinstance(block.get("thinking"), str):
                parts.append(f"[thinking] {block['thinking']}")
            elif t == "toolCall":
                args = block.get("arguments")
                args_s = json.dumps(args, ensure_ascii=False) if args else ""
                parts.append(f"[toolCall {block.get('name')}] {args_s}")
        return "\n".join(parts)
    return ""


def is_error_message(msg: dict) -> bool:
    role = msg.get("role")
    if role == "assistant":
        return msg.get("stopReason") == "error" or bool(msg.get("errorMessage"))
    if role == "toolResult":
        return bool(msg.get("isError"))
    if role == "bashExecution":
        code = msg.get("exitCode")
        return code is not None and code != 0
    return False


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_summary(args) -> int:
    print("PI LOGS — discovery")
    print()

    # Debug log
    if DEBUG_LOG.is_file():
        st = DEBUG_LOG.stat()
        print(f"debug    {DEBUG_LOG}  ({human_size(st.st_size)}, {fmt_age(st.st_mtime)})")
        dl = parse_debug_log(DEBUG_LOG)
        if dl.written_at:
            print(f"         written {dl.written_at}, terminal {dl.terminal}, "
                  f"{len(dl.rendered)} rendered lines, {len(dl.messages)} messages")
    else:
        print(f"debug    {DEBUG_LOG}  (absent — run /debug in pi to capture)")

    # Sessions
    print()
    sessions = find_sessions()
    if not sessions:
        print(f"sessions {SESSIONS_DIR}  (none found)")
    else:
        total_size = sum(p.stat().st_size for p in sessions)
        print(f"sessions {SESSIONS_DIR}  ({len(sessions)} file(s), {human_size(total_size)})")
        for p in sessions[:5]:
            st = p.stat()
            print(f"         {fmt_age(st.st_mtime):<10} {human_size(st.st_size):<10} {p.parent.name}/{p.name}")
        if len(sessions) > 5:
            print(f"         ... {len(sessions) - 5} more")

    # Temp logs
    print()
    temps = sorted(TMP_DIR.glob("pi-*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
    temp_glob = str(TMP_DIR / "pi-*.log")
    if not temps:
        print(f"temp     {temp_glob}  (none)")
    else:
        total = sum(p.stat().st_size for p in temps)
        print(f"temp     {temp_glob}  ({len(temps)} file(s), {human_size(total)})")
        for p in temps[:5]:
            st = p.stat()
            print(f"         {fmt_age(st.st_mtime):<10} {human_size(st.st_size):<10} {p.name}")
        if len(temps) > 5:
            print(f"         ... {len(temps) - 5} more")

    print()
    print("Next:")
    print("  uv run pi_logs.py debug              # grouped overview of the debug log")
    print("  uv run pi_logs.py session            # most recent session, structured summary")
    print("  uv run pi_logs.py temp --list        # list tool-output temp logs")
    print("  uv run pi_logs.py group <file>       # Unity-group any file")
    return 0


def cmd_debug(args) -> int:
    dl = parse_debug_log(DEBUG_LOG)
    if not dl.exists:
        eprint(f"debug log not found: {DEBUG_LOG}")
        eprint("run /debug in pi to capture it, then re-run.")
        return 1
    if dl.error:
        eprint(f"error reading {DEBUG_LOG}: {dl.error}")
        return 1

    print(f"DEBUG LOG: {DEBUG_LOG}")
    st = DEBUG_LOG.stat()
    print(f"size {human_size(st.st_size)} · written {dl.written_at or iso_local(st.st_mtime)} · terminal {dl.terminal}")
    print(f"{len(dl.rendered)} rendered lines · {len(dl.messages)} agent messages")
    print()

    section = args.section
    filt = re.compile(args.filter) if args.filter else None

    if section in ("lines", "all"):
        lines = [raw for (_idx, _vw, raw) in dl.rendered]
        strip = not args.no_ansi
        if filt:
            lines = [l for l in lines if filt.search(strip_ansi(l) if strip else l)]
        groups = group_lines(lines, strip_ansi_flag=strip, normalize=args.normalize)
        print(f"=== RENDERED LINES (grouped: {len(groups)} unique of {len(lines)}) ===")
        out = render_groups(
            groups, top=args.top, min_count=args.min, context=args.context,
            total=len(lines), unique=len(groups),
        )
        for line in out:
            print(line)
        print()
        if section == "lines":
            return 0

    if section in ("messages", "all"):
        msgs = dl.messages
        if filt:
            kept = []
            for m in msgs:
                if filt.search(extract_text(m)) or filt.search(json.dumps(m, ensure_ascii=False)):
                    kept.append(m)
            msgs = kept
        print(f"=== AGENT MESSAGES ({len(msgs)}) ===")
        _print_messages(msgs, args)
        if section == "messages":
            return 0

    return 0


def _print_messages(msgs: list[dict], args) -> None:
    role_counts: Counter = Counter()
    tool_counts: Counter = Counter()
    errors = 0
    tot_in = tot_out = 0
    cost = 0.0
    for m in msgs:
        r = message_role(m)
        role_counts[r] += 1
        if is_error_message(m):
            errors += 1
        if r == "assistant":
            usage = m.get("usage") or {}
            tot_in += usage.get("input", 0)
            tot_out += usage.get("output", 0)
            c = (usage.get("cost") or {}).get("total")
            if isinstance(c, (int, float)):
                cost += c
            for block in (m.get("content") or []) if isinstance(m.get("content"), list) else []:
                if isinstance(block, dict) and block.get("type") == "toolCall":
                    tool_counts[block.get("name", "?")] += 1
        if r == "toolResult":
            tool_counts[m.get("toolName", "?")] += 1

    parts = [f"{c} {r}" for r, c in role_counts.most_common()]
    print(f"roles: {', '.join(parts)}")
    if errors:
        print(f"errors: {errors}")
    if tool_counts:
        print(f"tools: {', '.join(f'{n}({c})' for n, c in tool_counts.most_common())}")
    if tot_in or tot_out:
        print(f"tokens: {tot_in:,} in · {tot_out:,} out · cost ${cost:.4f}")
    print()

    # If --grouped, group message text; else list each (capped).
    if getattr(args, "grouped", False):
        lines = [extract_text(m).replace("\n", " ⏎ ") for m in msgs]
        groups = group_lines(lines, strip_ansi_flag=True, normalize=args.normalize)
        print("grouped messages:")
        for line in render_groups(groups, top=args.top, min_count=1, context=False,
                                  total=len(lines), unique=len(groups)):
            print(line)
        return

    limit = getattr(args, "last", 0) or 50
    shown = msgs[-limit:] if len(msgs) > limit else msgs
    if len(msgs) > limit:
        print(f"(showing last {limit} of {len(msgs)} messages)")
    for m in shown:
        r = message_role(m)
        text = extract_text(m)
        flag = " [ERROR]" if is_error_message(m) else ""
        model = f" {m.get('provider')}/{m.get('model')}" if r == "assistant" else ""
        one = text.replace("\n", " ⏎ ")
        if len(one) > 240:
            one = one[:237] + "..."
        print(f"  {r}{model}{flag}: {one}")


def cmd_session(args) -> int:
    # Resolve target session file.
    path: Path | None
    if args.path:
        path = Path(args.path)
    else:
        cwd = args.cwd or os.getcwd()
        sessions = find_sessions(cwd)
        if not sessions:
            # fall back to newest overall
            sessions = find_sessions()
        if not sessions:
            eprint(f"no sessions found under {SESSIONS_DIR}")
            return 1
        path = sessions[0]
        eprint(f"using session: {path}")

    if not path.is_file():
        eprint(f"not a file: {path}")
        return 1

    sess = parse_session(path)
    if sess.error:
        eprint(f"error reading {path}: {sess.error}")
        return 1

    st = path.stat()
    print(f"SESSION: {path}")
    hdr = sess.header or {}
    print(f"cwd {hdr.get('cwd','?')} · v{hdr.get('version','?')} · "
          f"{len(sess.entries)} entries · {human_size(st.st_size)} · {fmt_age(st.st_mtime)}")
    print()

    # Choose entry set.
    if args.context:
        entries = walk_leaf_to_root(sess.entries)
        print(f"(current context path: {len(entries)} of {len(sess.entries)} entries)")
    else:
        entries = sess.entries
    if args.last:
        entries = entries[-args.last:]

    # Filters.
    def keep(e: dict) -> bool:
        if args.type and entry_type(e) != args.type:
            return False
        msg = e.get("message") if entry_type(e) == "message" else None
        if args.role and not (msg and message_role(msg) == args.role):
            return False
        if args.tool:
            if not msg:
                return False
            name = msg.get("toolName")
            if name != args.tool:
                # also match assistant toolCall names
                found = False
                for b in (msg.get("content") or []) if isinstance(msg.get("content"), list) else []:
                    if isinstance(b, dict) and b.get("type") == "toolCall" and b.get("name") == args.tool:
                        found = True
                        break
                if not found:
                    return False
        if args.errors:
            if not (msg and is_error_message(msg)):
                return False
        return True

    filtered = [e for e in entries if keep(e)]

    if args.summary:
        _session_summary(sess, entries)
        return 0

    if not filtered:
        print(f"no entries match filters ({len(entries)} considered).")
        print("use --summary for an overview.")
        return 0

    # Render.
    msgs = [e.get("message") for e in filtered if e.get("type") == "message" and e.get("message")]
    non_msg = [e for e in filtered if e.get("type") != "message"]

    if non_msg:
        print(f"=== STRUCTURE ENTRIES ({len(non_msg)}) ===")
        for e in non_msg:
            t = entry_type(e)
            extra = ""
            if t == "model_change":
                extra = f" -> {e.get('provider')}/{e.get('modelId')}"
            elif t == "thinking_level_change":
                extra = f" -> {e.get('thinkingLevel')}"
            elif t == "compaction":
                extra = f" ({e.get('tokensBefore')} tokens before)"
            elif t == "label":
                extra = f" '{e.get('label')}' on {e.get('targetId')}"
            elif t == "custom" or t == "custom_message":
                extra = f" customType={e.get('customType')}"
            print(f"  [{e.get('id','?')}] {t}{extra}")
        print()

    print(f"=== MESSAGES ({len(msgs)}) ===")
    _print_messages(msgs, args)
    return 0


def _session_summary(sess: Session, entries: list[dict]) -> None:
    type_counts: Counter = Counter()
    role_counts: Counter = Counter()
    tool_counts: Counter = Counter()
    errors = 0
    tot_in = tot_out = 0
    cost = 0.0
    for e in entries:
        type_counts[entry_type(e)] += 1
        msg = e.get("message") if e.get("type") == "message" else None
        if not msg:
            continue
        r = message_role(msg)
        role_counts[r] += 1
        if is_error_message(msg):
            errors += 1
        if r == "assistant":
            usage = msg.get("usage") or {}
            tot_in += usage.get("input", 0)
            tot_out += usage.get("output", 0)
            c = (usage.get("cost") or {}).get("total")
            if isinstance(c, (int, float)):
                cost += c
            for b in (msg.get("content") or []) if isinstance(msg.get("content"), list) else []:
                if isinstance(b, dict) and b.get("type") == "toolCall":
                    tool_counts[b.get("name", "?")] += 1
        if r == "toolResult":
            tool_counts[msg.get("toolName", "?")] += 1

    print("=== SUMMARY ===")
    print(f"entry types: {', '.join(f'{t}({c})' for t, c in type_counts.most_common())}")
    print(f"message roles: {', '.join(f'{r}({c})' for r, c in role_counts.most_common())}")
    if tool_counts:
        print(f"tools: {', '.join(f'{n}({c})' for n, c in tool_counts.most_common())}")
    if errors:
        print(f"errors: {errors}")
    if tot_in or tot_out:
        print(f"tokens: {tot_in:,} in · {tot_out:,} out · cost ${cost:.4f}")

    # Timeline
    if entries:
        first_ts = entries[0].get("timestamp")
        last_ts = entries[-1].get("timestamp")
        if first_ts and last_ts:
            print(f"timeline: {first_ts} -> {last_ts}")


def cmd_group(args) -> int:
    path = Path(args.file)
    if not path.is_file():
        eprint(f"not a file: {path}")
        return 1
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        eprint(f"error reading {path}: {exc}")
        return 1

    lines = text.splitlines()
    groups = group_lines(lines, strip_ansi_flag=not args.no_ansi, normalize=args.normalize)

    total = len(lines)
    unique = len(groups)
    print(f"FILE: {path}")
    print(f"{total} lines · {unique} unique ({human_size(path.stat().st_size)})")
    print()
    print(f"=== GROUPED ({unique} unique of {total}) ===")
    for line in render_groups(
        groups, top=args.top, min_count=args.min, context=args.context,
        total=total, unique=unique,
    ):
        print(line)
    return 0


def cmd_temp(args) -> int:
    if args.read:
        return _temp_read(Path(args.read), grouped=False)
    if args.grouped:
        return _temp_read(Path(args.grouped), grouped=True)

    # default: --list
    temps = sorted(TMP_DIR.glob("pi-*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not temps:
        print(f"no pi-*.log temp files in {TMP_DIR}")
        return 0
    total = sum(p.stat().st_size for p in temps)
    print(f"TEMP LOGS in {TMP_DIR}  ({len(temps)} files, {human_size(total)})")
    print()
    print(f"{'AGE':<10} {'SIZE':<10} FILE")
    for p in temps:
        st = p.stat()
        print(f"{fmt_age(st.st_mtime):<10} {human_size(st.st_size):<10} {p.name}")
    print()
    print("read one:    uv run pi_logs.py temp --read <name-or-path>")
    print("group one:   uv run pi_logs.py temp --grouped <name-or-path>")
    return 0


def _temp_read(path: Path, *, grouped: bool) -> int:
    # Allow passing just a basename in TMP_DIR.
    if not path.is_file():
        candidate = TMP_DIR / path.name
        if candidate.is_file():
            path = candidate
    if not path.is_file():
        eprint(f"not a file: {path}")
        return 1
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        eprint(f"error: {exc}")
        return 1

    lines = text.splitlines()
    st = path.stat()
    print(f"TEMP LOG: {path}")
    print(f"{len(lines)} lines · {human_size(st.st_size)} · {fmt_age(st.st_mtime)}")
    print()
    if not grouped:
        # Print grouped summary first, then tail.
        groups = group_lines(lines, strip_ansi_flag=True, normalize=None)
        print(f"=== GROUPED ({len(groups)} unique of {len(lines)}) ===")
        for line in render_groups(groups, top=20, min_count=1, context=False,
                                  total=len(lines), unique=len(groups)):
            print(line)
        print()
        print(f"=== TAIL (last 40 lines) ===")
        for line in lines[-40:]:
            print(line)
    else:
        groups = group_lines(lines, strip_ansi_flag=True, normalize=None)
        print(f"=== GROUPED ({len(groups)} unique of {len(lines)}) ===")
        for line in render_groups(groups, top=200, min_count=1, context=False,
                                  total=len(lines), unique=len(groups)):
            print(line)
    return 0


# ---------------------------------------------------------------------------
# Argparse
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="pi_logs.py",
        description="Read and interface with pie (pi coding agent) logs.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = p.add_subparsers(dest="cmd")

    # summary (default)
    sp = sub.add_parser("summary", help="Discover all pi logs and their sizes.")
    sp.set_defaults(func=cmd_summary)

    # debug
    sp = sub.add_parser("debug", help="Read the pi-debug.log snapshot.")
    sp.add_argument("--section", choices=("lines", "messages", "all"), default="all")
    sp.add_argument("--top", type=int, default=25, help="Top N groups to show (default 25).")
    sp.add_argument("--min", type=int, default=1, help="Minimum count to show (default 1).")
    sp.add_argument("--filter", help="Regex; only lines/messages matching are kept.")
    sp.add_argument("--normalize", help="Group key regex ('smart' = timestamps/ids/numbers).")
    sp.add_argument("--no-ansi", action="store_true", help="Do not strip ANSI (group on raw escape sequences).")
    sp.add_argument("--context", action="store_true", help="Show first/last line index per group.")
    sp.add_argument("--grouped", action="store_true", help="Group message text.")
    sp.add_argument("--last", type=int, default=0, help="Limit messages to last N (default 50).")
    sp.set_defaults(func=cmd_debug)

    # session
    sp = sub.add_parser("session", help="Read a session JSONL (default: most recent).")
    sp.add_argument("path", nargs="?", help="Session .jsonl path. Defaults to most recent.")
    sp.add_argument("--cwd", help="Find session for this cwd (default: current).")
    sp.add_argument("--summary", action="store_true", help="Overview only.")
    sp.add_argument("--role", help="Filter message role (user/assistant/toolResult/bashExecution/...).")
    sp.add_argument("--type", help="Filter entry type (session/message/model_change/...).")
    sp.add_argument("--tool", help="Filter tool name (toolResult.toolName or toolCall.name).")
    sp.add_argument("--errors", action="store_true", help="Only error/failed entries.")
    sp.add_argument("--grouped", action="store_true", help="Group identical message text.")
    sp.add_argument("--last", type=int, default=0, help="Limit to last N entries.")
    sp.add_argument("--context", action="store_true", help="Walk current leaf->root (the LLM context).")
    sp.add_argument("--normalize", help="Group key regex ('smart' = timestamps/ids/numbers).")
    sp.add_argument("--top", type=int, default=25)
    sp.set_defaults(func=cmd_session)

    # group
    sp = sub.add_parser("group", help="Unity-group the lines of ANY file.")
    sp.add_argument("file", help="File to group.")
    sp.add_argument("--top", type=int, default=50, help="Top N groups (default 50).")
    sp.add_argument("--min", type=int, default=1, help="Minimum count (default 1).")
    sp.add_argument("--normalize", help="Group key regex ('smart' = timestamps/ids/numbers).")
    sp.add_argument("--no-ansi", action="store_true", help="Do not strip ANSI.")
    sp.add_argument("--context", action="store_true", help="Show first/last line index per group.")
    sp.set_defaults(func=cmd_group)

    # temp
    sp = sub.add_parser("temp", help="List / read tool-output temp logs (pi-*.log).")
    sp.add_argument("--list", action="store_true", help="List temp logs (default).")
    sp.add_argument("--read", help="Read a temp log (grouped summary + tail).")
    sp.add_argument("--grouped", help="Grouped-only read of a temp log.")
    sp.set_defaults(func=cmd_temp)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        return cmd_summary(args)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
