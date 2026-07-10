#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     # Pin to the last version that does not depend on tree-sitter-dart-orchard,
#     # which only publishes an sdist and therefore requires MSVC on Windows.
#     "skylos==4.10.0",
# ]
# ///
"""
Detect dead code (unused functions, classes, and imports) via skylos.

Usage:
    uv run find_dead_code.py <directory> [options]

Runs skylos (via ``skylos`` on PATH, or ``uv run --with skylos skylos`` as
fallback) to find unused functions, classes, and imports across Python,
TypeScript, JavaScript, Java, Go, PHP, Rust, and Dart.

Respects the shared .ignore file (see find_large_files.py for format
details).

skylos only exposes ``--exclude-folder NAME``, which is a directory name and
not a glob. Patterns ending in ``/`` and bare directory names map cleanly;
file-level globs like ``*.min.js`` cannot be expressed and are reported on
stderr (add a project-level skylos config to extend coverage).

Arguments:
    directory              Root directory to scan (required)
    --max-findings N       Cap findings per section (default 50; 0 = unlimited)
    --confidence N         Minimum confidence 0-100 (default 60)
    --exclude-reasons REASONS
                           Comma-separated reason substrings to exclude
                           (e.g. "unused import,unused variable") — findings
                           whose trailing reason text matches a substring are
                           dropped (default: none — all reasons shown)
    --verify-dead-code     Cross-reference skylos findings by searching for
                           the reported symbol across the codebase. Findings
                           whose symbol is referenced elsewhere are flagged as
                           likely false positives.

Output:
    Dead-code findings:

        === Dead code — 167 (89 import, 38 variable, 15 function, 11 file, 5 class) ===
          extension/src/webview/panel/file-path.tsx  L14 unused function, L35 unused function, ...
          extension/src/host/session-service/events.ts  16 import
          ...

    Non-trivial findings (function, class, file) are grouped by file with
    line numbers. Trivial findings (import, variable) are aggregated by
    file with counts. A category summary appears in the header.

    With --verify-dead-code, only verified (likely dead) findings are printed
    and likely false positives are suppressed:

        === Dead code — 103 verified of 167 (64 likely false positives suppressed) ===
          extension/src/webview/panel/file-path.tsx  L14 unused function, ...
          ...

    No findings:

        === Dead code — none ===

Exit codes:
    0  no findings, or findings only (tool exit 1 remapped to 0)
    2  tool itself errored, missing dependency, or bad arguments
"""

import fnmatch
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path, PurePosixPath

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
IGNORE_FILE_NAMES: tuple[str, ...] = (".ignore", ".codebase-ignore")

SKYLOS_HINT = (
    "Error: skylos not found in PATH and uv not found for fallback.\n"
    "Recommended: install uv (https://docs.astral.sh/uv/) and this script "
    "will use `uv run --with skylos skylos` automatically.\n"
    "Alternatively: pip install --user skylos, then re-run this script."
)

# Strip ANSI color escapes that skylos may emit even with --no-tips on some
# terminals. The concise format uses plain text but defensive trimming is cheap.
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


# ---------------------------------------------------------------------------
# Ignore-file loading (duplicated from find_large_files.py for self-containment)
# ---------------------------------------------------------------------------

def normalize_path_token(value: str, *, strip_trailing_slash: bool) -> str:
    normalized = value.strip().replace("\\", "/")
    while "//" in normalized:
        normalized = normalized.replace("//", "/")
    if normalized.startswith("./"):
        normalized = normalized[2:]
    if strip_trailing_slash:
        normalized = normalized.rstrip("/")
    return normalized


def load_ignore_patterns(
    script_dir: Path,
) -> tuple[list[str], list[tuple[str, list[str]]]]:
    """
    Parse the canonical ignore file from *script_dir*.

    Returns ``(global_patterns, context_patterns)`` where *context_patterns*
    is a list of ``(context_path, [pattern, ...])`` pairs.
    """
    global_patterns: list[str] = []
    context_patterns: list[tuple[str, list[str]]] = []

    ignore_file = next(
        (script_dir / name for name in IGNORE_FILE_NAMES if (script_dir / name).exists()),
        None,
    )

    if ignore_file is None:
        return global_patterns, context_patterns

    current_context: str | None = None
    for line in ignore_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("context "):
            ctx = normalize_path_token(line[len("context "):], strip_trailing_slash=True)
            current_context = ctx
            context_patterns.append((ctx, []))
        else:
            pattern = normalize_path_token(line, strip_trailing_slash=False)
            if current_context is not None:
                context_patterns[-1][1].append(pattern)
            else:
                global_patterns.append(pattern)

    return global_patterns, context_patterns


def scan_root_matches_context(scan_root: Path, context_path: str) -> bool:
    """Return ``True`` when *context_path* applies to the scanned directory."""
    normalized_context = normalize_path_token(context_path, strip_trailing_slash=True)
    if not normalized_context:
        return False

    normalized_root = normalize_path_token(
        scan_root.resolve().as_posix(),
        strip_trailing_slash=True,
    )

    if fnmatch.fnmatch(normalized_root, normalized_context):
        return True

    return normalized_root == normalized_context or normalized_root.endswith(f"/{normalized_context}")


def collect_active_ignore_patterns(
    scan_root: Path,
    global_patterns: list[str],
    context_patterns: list[tuple[str, list[str]]],
) -> list[str]:
    active_patterns = list(global_patterns)
    for context_path, patterns in context_patterns:
        if scan_root_matches_context(scan_root, context_path):
            active_patterns.extend(patterns)
    return active_patterns


def matches_ignore_pattern(file_rel_path: str, pattern: str) -> bool:
    normalized_path = normalize_path_token(file_rel_path, strip_trailing_slash=True)
    if not normalized_path:
        return False

    path_parts = [part for part in PurePosixPath(normalized_path).parts if part not in ("", ".")]
    if not path_parts:
        return False

    basename = path_parts[-1]
    dir_paths: list[str] = []
    current_parts: list[str] = []
    for part in path_parts[:-1]:
        current_parts.append(part)
        dir_paths.append("/".join(current_parts))

    normalized_pattern = normalize_path_token(pattern, strip_trailing_slash=False)
    if not normalized_pattern:
        return False

    if normalized_pattern.endswith("/"):
        directory_pattern = normalized_pattern.rstrip("/")
        if any(fnmatch.fnmatch(dir_path, directory_pattern) for dir_path in dir_paths):
            return True
        if "/" not in directory_pattern:
            return any(fnmatch.fnmatch(part, directory_pattern) for part in path_parts[:-1])
        return False

    if fnmatch.fnmatch(normalized_path, normalized_pattern):
        return True
    if fnmatch.fnmatch(basename, normalized_pattern):
        return True
    if any(fnmatch.fnmatch(dir_path, normalized_pattern) for dir_path in dir_paths):
        return True
    if "/" not in normalized_pattern:
        return any(fnmatch.fnmatch(part, normalized_pattern) for part in path_parts)
    return False


def matches_ignore_patterns(file_rel_path: str, active_patterns: list[str]) -> bool:
    """Return ``True`` if *file_rel_path* matches any active ignore pattern."""
    return any(matches_ignore_pattern(file_rel_path, pattern) for pattern in active_patterns)


def _rel_path_from_skylos_line(line: str, directory: Path) -> str:
    """Extract the file path from a skylos concise line and make it relative."""
    m = re.match(r"^(?P<path>.+?):(?P<line>\d+)(?P<rest>.*)$", line)
    if not m:
        return ""
    return to_rel_posix(m.group("path"), directory)


def to_rel_posix(raw: str, directory: Path) -> str:
    """Return *raw* as a posix path relative to *directory* when possible.

    Falls back to the file name when *raw* is not under *directory*. Mixed
    `\\` / `/` separators are normalised. Returns an empty string if no
    usable name can be extracted.
    """
    if not raw:
        return ""
    cleaned = raw.replace("\x00", "").strip().strip('"').strip("'")
    if not cleaned:
        return ""
    p = Path(cleaned)
    try:
        return p.resolve().relative_to(directory.resolve()).as_posix()
    except (ValueError, OSError):
        return p.name or cleaned


def _find_binary(name: str) -> str | None:
    """Find *name* on PATH, falling back to the user Scripts directory on Windows.

    Returns the absolute path if found, or None.
    """
    found = shutil.which(name)
    if found is not None:
        return found
    # On Windows, pip install --user puts scripts in a directory that may not
    # be on PATH. Check the user site-packages Scripts directory.
    if sys.platform == "win32":
        import site
        user_site = site.getusersitepackages()
        if user_site:
            scripts_dir = Path(user_site).parent.parent / "Scripts"
            candidate = scripts_dir / f"{name}.exe"
            if candidate.is_file():
                return str(candidate)
    return None


# ---------------------------------------------------------------------------
# skylos — dead-code detection
# ---------------------------------------------------------------------------

def _patterns_for_skylos(active_patterns: list[str]) -> tuple[list[str], list[str]]:
    """Split shared .ignore patterns into (exclude_folders, dropped_globs).

    skylos exposes only ``--exclude-folder NAME`` (a directory name, not a
    glob) and ``--file-filter PATTERN`` (which is an **include** filter, not
    an exclude). The shared .ignore file mixes directory markers, bare
    directory names, and file-level globs like ``*.min.js`` — only the first
    two categories can be expressed. Glob patterns are returned in the
    second tuple so the caller can warn that they cannot be honoured by
    skylos, and so users can decide whether to live with the gap or add a
    project-level skylos config.
    """
    folders: list[str] = []
    dropped: list[str] = []
    for p in active_patterns:
        if not p:
            continue
        if p.endswith("/"):
            folders.append(p.rstrip("/"))
        elif any(ch in p for ch in "*?["):
            # Glob pattern — skylos has no file-level exclude.
            dropped.append(p)
        else:
            # Bare name with no glob chars — treat as a directory.
            folders.append(p)
    return folders, dropped


def run_skylos(
    directory: Path,
    skylos_argv: list[str],
    confidence: int,
    exclude_folders: list[str],
) -> list[str]:
    """Run skylos --format concise and return the (already-trimmed) finding lines."""
    cmd: list[str] = [
        *skylos_argv,
        "--format", "concise",
        "--confidence", str(confidence),
    ]
    for folder in exclude_folders:
        cmd += ["--exclude-folder", folder]
    cmd.append(str(directory))

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=600,
        )
    except subprocess.TimeoutExpired:
        print("Error: skylos scan timed out after 600 s", file=sys.stderr)
        sys.exit(2)
    except OSError as exc:
        print(f"Error: could not run skylos: {exc}", file=sys.stderr)
        sys.exit(2)

    # skylos exit 0 = clean, 1 = findings (not an error).
    if result.returncode >= 2:
        print(
            f"skylos error (exit {result.returncode}): "
            f"{result.stderr.strip()[:500]}",
            file=sys.stderr,
        )
        sys.exit(result.returncode)

    lines: list[str] = []
    for raw in result.stdout.splitlines():
        line = _ANSI_RE.sub("", raw).rstrip()
        if line.strip():
            lines.append(line)
    return lines


def _normalise_skylos_line(line: str, directory: Path) -> str | None:
    """Rewrite a skylos concise line so the path is relative to *directory*.

    Skylos prints ``<abs_path>:<line>  <reason>``. We keep the format but
    replace the absolute prefix with a relative posix path. Lines that don't
    match the expected shape are returned unchanged.
    """
    m = re.match(r"^(?P<path>.+?):(?P<line>\d+)(?P<rest>.*)$", line)
    if not m:
        return line
    abs_path = m.group("path")
    rel = to_rel_posix(abs_path, directory)
    if rel and rel != abs_path:
        return f"{rel}:{m.group('line')}{m.group('rest')}"
    return line


def _extract_symbol_from_line(line_text: str) -> str | None:
    """Extract the identifier name from a source line.

    Looks for common declaration keywords (function, class, const, etc.)
    followed by an identifier. Returns the identifier, or None if no
    recognisable pattern is found.
    """
    patterns = [
        r'(?:async\s+)?function\s+([A-Za-z_]\w*)',
        r'class\s+([A-Za-z_]\w*)',
        r'(?:const|let|var)\s+([A-Za-z_]\w*)',
        r'interface\s+([A-Za-z_]\w*)',
        r'type\s+([A-Za-z_]\w*)',
        r'enum\s+([A-Za-z_]\w*)',
        r'export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)',
        r'export\s+(?:default\s+)?class\s+([A-Za-z_]\w*)',
        r'export\s+(?:const|let|var)\s+([A-Za-z_]\w*)',
        r'def\s+([A-Za-z_]\w*)',
    ]
    for pat in patterns:
        m = re.search(pat, line_text)
        if m:
            return m.group(1)
    return None


def _rg_search_symbol(
    symbol: str, def_file: str, directory: Path, active_patterns: list[str],
) -> bool:
    """Use ripgrep to search for *symbol* as a word-boundary match.

    Returns True if the symbol appears in any file other than *def_file*
    (respecting .ignore patterns).
    """
    try:
        result = subprocess.run(
            ["rg", "-l", "--word-regexp", symbol, str(directory)],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (subprocess.TimeoutExpired, OSError):
        return False

    if result.returncode not in (0, 1):  # 0 = matches, 1 = no matches
        return False

    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        try:
            rel = Path(line.strip()).relative_to(directory).as_posix()
        except (ValueError, OSError):
            rel = line.strip()
        if rel == def_file:
            continue
        if matches_ignore_patterns(rel, active_patterns):
            continue
        return True
    return False


def _python_search_symbol(
    symbol: str, def_file: str, directory: Path, active_patterns: list[str],
) -> bool:
    """Fall back to a pure-Python search for *symbol* as a word-boundary match.

    Returns True if the symbol appears in any file other than *def_file*
    (respecting .ignore patterns).
    """
    pattern = re.compile(r'\b' + re.escape(symbol) + r'\b')
    for path in directory.rglob("*"):
        if not path.is_file():
            continue
        try:
            rel = path.relative_to(directory).as_posix()
        except ValueError:
            continue
        if rel == def_file:
            continue
        if matches_ignore_patterns(rel, active_patterns):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except (OSError, UnicodeDecodeError):
            continue
        if pattern.search(text):
            return True
    return False


def _verify_dead_code(
    findings: list[str], directory: Path, active_patterns: list[str],
) -> tuple[list[str], list[str]]:
    """Verify skylos findings by cross-referencing symbol usage.

    For each finding, parses the path and line number, reads the symbol
    from the source, and searches for it across the codebase. Findings
    whose symbol appears in other files are classified as likely false
    positives.

    Returns (verified_dead, likely_false_positives).
    """
    verified: list[str] = []
    false_positives: list[str] = []

    rg_available = shutil.which("rg") is not None

    for finding in findings:
        # Parse "path:line  reason"
        m = re.match(r"^(.+?):(\d+)\s{2}(.+)$", finding)
        if not m:
            verified.append(finding)
            continue

        file_path_str, line_num_str, _reason = m.groups()
        line_num = int(line_num_str)
        file_path = directory / file_path_str

        try:
            lines = file_path.read_text(encoding="utf-8", errors="replace").splitlines()
        except (OSError, IOError):
            verified.append(finding)
            continue

        if line_num < 1 or line_num > len(lines):
            verified.append(finding)
            continue

        source_line = lines[line_num - 1]
        symbol = _extract_symbol_from_line(source_line)
        if symbol is None:
            verified.append(finding)
            continue

        # Search for the symbol across the codebase.
        if rg_available:
            is_used = _rg_search_symbol(symbol, file_path_str, directory, active_patterns)
        else:
            is_used = _python_search_symbol(symbol, file_path_str, directory, active_patterns)

        if is_used:
            false_positives.append(finding)
        else:
            verified.append(finding)

    return verified, false_positives


def print_dead_code(
    skylos_lines: list[str], directory: Path, max_findings: int,
    skip_header: bool = False,
) -> int:
    """Print dead-code findings in a compact, agent-friendly format.

    Prints a one-line category summary, then groups findings:
    - Non-trivial types (function, class, file) are listed by file with
      line numbers.
    - Trivial types (import, variable) are aggregated by file with counts.

    Returns the total number of findings found.
    """
    if not skylos_lines:
        if not skip_header:
            print("=== Dead code \u2014 none ===")
        return 0

    rewritten = list(filter(None, [_normalise_skylos_line(l, directory) for l in skylos_lines]))

    # Classify each finding by type and file.
    # Skylos concise format: "path:line  reason"
    finding_type: dict[str, str] = {}   # line_text -> normalised type
    for line in rewritten:
        tail = line.split("  ", 1)[-1].strip().lower()
        if "function" in tail:
            finding_type[line] = "function"
        elif "class" in tail:
            finding_type[line] = "class"
        elif "file" in tail and ("not imported" in tail or "unused" in tail):
            finding_type[line] = "file"
        elif "import" in tail:
            finding_type[line] = "import"
        elif "variable" in tail:
            finding_type[line] = "variable"
        else:
            finding_type[line] = tail  # keep original for unknown types

    # Category summary line.
    cat_counts: dict[str, int] = {}
    for ft in finding_type.values():
        cat_counts[ft] = cat_counts.get(ft, 0) + 1
    if not skip_header:
        summary_parts = [f"{v} {k}" for k, v in sorted(cat_counts.items(), key=lambda x: x[1], reverse=True)]
        print(f"=== Dead code \u2014 {len(rewritten)} ({', '.join(summary_parts)}) ===")

    # Separate non-trivial (function, class, file) from trivial (import, variable).
    non_trivial = [line for line in rewritten if finding_type.get(line) in ("function", "class", "file")]
    trivial = [line for line in rewritten if finding_type.get(line) not in ("function", "class", "file")]

    # --- Non-trivial: group by file, list with line numbers --->
    if non_trivial:
        file_groups: dict[str, list[str]] = {}
        for line in non_trivial:
            m = re.match(r"^(.+?):(\d+)", line)
            filepath = m.group(1) if m else line.split()[0]
            file_groups.setdefault(filepath, []).append(line)
        # Sort groups by count desc, then filepath.
        sorted_groups = sorted(
            file_groups.items(),
            key=lambda item: (-len(item[1]), item[0]),
        )
        shown_groups = sorted_groups[:max_findings] if max_findings > 0 else sorted_groups
        for filepath, lines in shown_groups:
            # Extract just "line type" for compactness.
            entries = []
            for line in lines:
                m = re.match(r"^.+?:(\d+)\s{2}(.+)", line)
                if m:
                    entries.append(f"L{m.group(1)} {m.group(2).strip()}")
                else:
                    entries.append(line.strip())
            print(f"  {filepath}  {', '.join(entries)}")
        remaining = len(sorted_groups) - len(shown_groups)
        if remaining > 0:
            print(f"  ... {remaining} more files")

    # --- Trivial: aggregate by file with type counts --->
    if trivial:
        file_type_counts: dict[str, dict[str, int]] = {}
        for line in trivial:
            m = re.match(r"^(.+?):(\d+)", line)
            filepath = m.group(1) if m else line.split()[0]
            ft = finding_type.get(line, "other")
            file_type_counts.setdefault(filepath, {})
            file_type_counts[filepath][ft] = file_type_counts[filepath].get(ft, 0) + 1
        # Sort files by total trivial count desc.
        sorted_files = sorted(
            file_type_counts.items(),
            key=lambda item: (-sum(item[1].values()), item[0]),
        )
        shown_files = sorted_files[:max_findings] if max_findings > 0 else sorted_files
        for filepath, type_counts in shown_files:
            tc_parts = [f"{v} {k}" for k, v in sorted(type_counts.items(), key=lambda x: x[1], reverse=True)]
            print(f"  {filepath}  {', '.join(tc_parts)}")
        remaining = len(sorted_files) - len(shown_files)
        if remaining > 0:
            print(f"  ... {remaining} more files")

    return len(rewritten)


def _locate_skylos() -> list[str]:
    """Return the argv prefix for invoking skylos.

    Tries, in order:
      1. ``skylos`` on PATH (fast path, no venv overhead).
      2. ``uv run --with skylos skylos`` (uv downloads skylos into an
         isolated venv on the fly; much friendlier than requiring a
         manual install).
      3. Exits with SKYLOS_HINT if neither is available.
    """
    skylos = _find_binary("skylos")
    if skylos is not None:
        return [skylos]
    uv = _find_binary("uv")
    if uv is not None:
        # Pin skylos to a version whose dependency tree ships prebuilt wheels
        # on Windows, so ``uv run`` does not require MSVC build tools.
        # skylos >=4.11 pulls in ``tree-sitter-dart-orchard``, which publishes
        # only an sdist (no wheels) and therefore must be compiled from source
        # — needing Microsoft Visual C++ 14.0+. skylos 4.10.0 still supports
        # TypeScript/JavaScript (the common case) but predates the Dart grammar
        # dependency. Override with the ``SKYLOS_VERSION`` env var (e.g.
        # ``SKYLOS_VERSION=4.29.0``) where a newer skylos is available/needed.
        version = os.environ.get("SKYLOS_VERSION", "4.10.0")
        spec = f"skylos=={version}" if version else "skylos"
        return [uv, "run", "--with", spec, "skylos"]
    print(SKYLOS_HINT, file=sys.stderr)
    sys.exit(2)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> tuple[Path, int, int, set[str], bool]:
    if len(sys.argv) >= 2 and sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)
    if len(sys.argv) < 2:
        print(
            "usage: find_dead_code.py <directory> "
            "[--max-findings N] [--confidence N] "
            "[--exclude-reasons REASONS] [--verify-dead-code]",
            file=sys.stderr,
        )
        sys.exit(2)

    directory = Path(sys.argv[1]).resolve()
    if not directory.is_dir():
        print(f"error: not a directory: {sys.argv[1]}", file=sys.stderr)
        sys.exit(2)

    max_findings = 50
    confidence = 60
    verify_dead_code = False
    exclude_reasons: set[str] = set()

    i = 2
    while i < len(sys.argv):
        a = sys.argv[i]
        if a == "--max-findings" and i + 1 < len(sys.argv):
            try:
                max_findings = int(sys.argv[i + 1])
            except ValueError:
                print("error: --max-findings must be an integer", file=sys.stderr)
                sys.exit(2)
            i += 2
        elif a == "--confidence" and i + 1 < len(sys.argv):
            try:
                confidence = int(sys.argv[i + 1])
            except ValueError:
                print("error: --confidence must be an integer", file=sys.stderr)
                sys.exit(2)
            i += 2
        elif a == "--exclude-reasons" and i + 1 < len(sys.argv):
            exclude_reasons = set(r.strip() for r in sys.argv[i + 1].split(",") if r.strip())
            i += 2
        elif a == "--verify-dead-code":
            verify_dead_code = True
            i += 1
        else:
            print(f"unknown argument: {a}", file=sys.stderr)
            sys.exit(2)

    if not 0 <= confidence <= 100:
        print("error: --confidence must be in 0..100", file=sys.stderr)
        sys.exit(2)

    return directory, max_findings, confidence, exclude_reasons, verify_dead_code


def main() -> None:
    directory, max_findings, confidence, exclude_reasons, verify_dead_code = parse_args()

    script_dir = Path(__file__).parent.resolve()
    global_patterns, context_patterns = load_ignore_patterns(script_dir)
    active_patterns = collect_active_ignore_patterns(
        directory, global_patterns, context_patterns,
    )

    skylos_argv = _locate_skylos()
    exclude_folders, dropped_globs = _patterns_for_skylos(active_patterns)
    if dropped_globs:
        print(
            f"# note: {len(dropped_globs)} .ignore glob pattern(s) cannot be "
            f"expressed as skylos --exclude-folder and will be applied as a "
            f"post-filter on the script output.",
            file=sys.stderr,
        )
    findings = run_skylos(
        directory, skylos_argv, confidence, exclude_folders,
    )

    # Post-filter: apply all ignore patterns that skylos could not express
    # (file-level globs) plus any patterns skylos may have missed.
    findings = [
        l for l in findings
        if not matches_ignore_patterns(_rel_path_from_skylos_line(l, directory), active_patterns)
    ]

    if exclude_reasons:
        findings = [l for l in findings if l.split("  ", 1)[-1].strip() not in exclude_reasons]

    if verify_dead_code:
        verified, false_positives = _verify_dead_code(findings, directory, active_patterns)
        total = len(verified) + len(false_positives)
        header = f"=== Dead code \u2014 {len(verified)} verified of {total}"
        if false_positives:
            header += f" ({len(false_positives)} likely false positives suppressed)"
        print(header)
        # Print verified findings using the grouped format.
        if not verified:
            print("  (no verified dead code; all findings were likely false positives)")
        else:
            # Reuse print_dead_code's grouped layout for the verified subset.
            print_dead_code(verified, directory, max_findings, skip_header=True)
    else:
        print_dead_code(findings, directory, max_findings)


if __name__ == "__main__":
    main()