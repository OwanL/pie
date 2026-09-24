#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""
Detect duplicate code blocks via jscpd (copy/paste detector).

Usage:
    uv run find_duplicates.py <directory> [options]

Runs jscpd (via npx) for copy/paste and token-level duplicate detection
across 150+ languages. npx downloads jscpd on first use; no install step.

Respects the shared .ignore file (see find_large_files.py for format
details). Findings are grouped into three categories — cross-file,
same-file, and generated-file — with generated findings summarised by
default (use --show-generated to list them).

jscpd's file-level ``--ignore`` option accepts comma-separated globs, so
active shared patterns are translated to scan-root-relative file globs before
execution. ``--ignore-pattern`` excludes token content, not files.

Arguments:
    directory              Root directory to scan (required)
    --max-findings N       Cap findings per section (default 50; 0 = unlimited)
    --min-lines N          Minimum duplicated lines per block (default 8)
    --min-tokens N         Minimum duplicated tokens per block (default 70)
    --show-generated       Include generated-file duplicate details in output
                           (hidden by default; generated files include lock
                           files, .min.* assets, and node_modules/)
    --exclude-test-directories
                           Skip any directory named `test` when scanning for
                           duplicates. Use when test boilerplate dominates the
                           report.

Output:
    Duplicate findings are grouped into sections:

        === Cross-file duplicates — 52 ===
          path/A.py:1-12 ~ path/B.py:1-12  12L 64T
          ...

        === Same-file duplicates — 91 blocks in 28 files ===
          stats-service.test.ts  12 blocks 247L
          ...

        === Generated-file duplicates — 4 (use --show-generated for details) ===

    Cross-file pairs show individual locations with line/token counts.
    Same-file duplicates are grouped by file with block count and total lines.
    Generated-file duplicates appear as a one-line size summary by default;
    with --show-generated, bucket details are shown:

        === Generated-file duplicates — 4 (2 50+L, 1 20-49L, 1 <20L) ===

    Sections with no findings print "=== Section — none ===". If a section
    exceeds --max-findings, a one-line remainder summary is printed.

Exit codes:
    0  scan completed, with or without findings
    nonzero  jscpd failed; a partial report does not make the scan successful
    2  tool itself errored, missing dependency, or bad arguments
"""

import fnmatch
import json
import re
import shutil
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path, PurePosixPath

# ---------------------------------------------------------------------------
# Ignore-file constants (duplicated from find_large_files.py)
# ---------------------------------------------------------------------------
IGNORE_FILE_NAMES: tuple[str, ...] = (".ignore", ".codebase-ignore")


# ---------------------------------------------------------------------------
# Ignore-file loading (duplicated from find_large_files.py)
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


# ---------------------------------------------------------------------------
# Tool installation hints
# ---------------------------------------------------------------------------
NPX_HINT = (
    "Error: npx not found in PATH.\n"
    "jscpd is downloaded on first use via npx, which ships with Node.js/npm.\n"
    "Install Node.js from https://nodejs.org/ and re-run this script."
)

# Pattern for recognising generated / vendored / lock files.
_GENERATED_FILE_RE = re.compile(
    r'(?:^|/)('
    r'package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock|poetry\.lock'
    r')$'
    r'|\.min\.(js|mjs|css)$'
    r'|(?:^|/)node_modules/'
)


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------
def to_rel_posix(raw: str, directory: Path) -> str:
    """Return a jscpd report path relative to the scan root when possible."""
    if not raw:
        return ""
    cleaned = raw.replace("\x00", "").strip().strip('"').strip("'")
    if not cleaned:
        return ""
    p = Path(cleaned.replace("\\", "/"))
    root = directory.resolve()
    if p.is_absolute():
        candidates = [p]
    elif p.parts and p.parts[0] == directory.name:
        candidates = [directory.parent / p, directory / Path(*p.parts[1:])]
    else:
        # Modern jscpd reports paths relative to the path being scanned.
        candidates = [directory / p, Path.cwd() / p]
    for candidate in candidates:
        try:
            return candidate.resolve().relative_to(root).as_posix()
        except (ValueError, OSError):
            continue
    return p.as_posix()


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
        user_base = site.getsitepackages()[0] if site.getusersitepackages() else None
        user_site = site.getusersitepackages()
        if user_site:
            scripts_dir = Path(user_site).parent.parent / "Scripts"
            candidate = scripts_dir / f"{name}.exe"
            if candidate.is_file():
                return str(candidate)
    return None


def _path_in_test_dir(raw_path: str, directory: Path) -> bool:
    """Return True if *raw_path* is inside a directory named `test`."""
    rel = to_rel_posix(raw_path, directory)
    if not rel:
        rel = raw_path.replace("\\", "/")
    parts = PurePosixPath(rel).parts
    # Exclude the file name itself — only directory parts matter.
    return len(parts) > 1 and "test" in parts[:-1]


def _is_generated_path(path: str) -> bool:
    """Return True if *path* looks like a generated or vendored file."""
    return bool(_GENERATED_FILE_RE.search(path))


def _extract_filepath(formatted: str) -> str:
    """Extract the file path from a formatted string like 'src/foo.py:1-12'."""
    idx = formatted.rfind(":")
    return formatted[:idx] if idx > 0 else formatted


# ---------------------------------------------------------------------------
# jscpd — duplicate detection
# ---------------------------------------------------------------------------
def _ignore_patterns_for_jscpd(active_patterns: list[str]) -> list[str]:
    """Translate shared patterns to jscpd's file-level ``--ignore`` globs.

    Shared patterns containing a slash are relative to the scan root, while
    basename patterns match at any depth.  Preserve that distinction instead
    of prefixing every pattern with ``**/``.
    """
    out: list[str] = []
    for pattern in active_patterns:
        normalized = normalize_path_token(pattern, strip_trailing_slash=False)
        if not normalized:
            continue
        is_directory = normalized.endswith("/")
        normalized = normalized.rstrip("/")
        any_depth = "/" not in normalized
        prefix = "**/" if any_depth else ""
        suffix = "/**" if is_directory else ""
        glob = f"{prefix}{normalized}{suffix}"
        if glob not in out:
            out.append(glob)
    return out


def run_jscpd(
    directory: Path,
    jscpd_argv: list[str],
    min_lines: int,
    min_tokens: int,
    ignore_globs: list[str],
) -> list[dict]:
    """Run jscpd and return its parsed duplicates, or exit on tool failure."""
    with tempfile.TemporaryDirectory(prefix="jscpd-") as tmp:
        report_dir = Path(tmp)
        cmd: list[str] = [
            *jscpd_argv,
            "--silent",
            "--no-tips",
            "--reporters", "json",
            "--output", str(report_dir),
            "--min-lines", str(min_lines),
            "--min-tokens", str(min_tokens),
        ]
        if ignore_globs:
            cmd += ["--ignore", ",".join(ignore_globs)]
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
            print("Error: jscpd scan timed out after 600 s", file=sys.stderr)
            sys.exit(2)
        except OSError as exc:
            print(f"Error: could not run jscpd: {exc}", file=sys.stderr)
            sys.exit(2)

        # Read the JSON report while the temp dir still exists; the
        # ``with`` block tears it down as soon as we return.
        duplicates = _read_jscpd_report(report_dir) or []

    if result.returncode != 0:
        diagnostics = result.stderr.strip()[:500]
        if duplicates:
            partial = f"partial report contains {len(duplicates)} duplicate(s)"
            diagnostics = f"{diagnostics}; {partial}" if diagnostics else partial
        print(
            f"jscpd error (exit {result.returncode}): {diagnostics}",
            file=sys.stderr,
        )
        sys.exit(result.returncode)

    return duplicates


def _read_jscpd_report(report_dir: Path) -> list[dict] | None:
    """Return the parsed ``duplicates`` list from jscpd's JSON report, if any.

    Returns ``None`` only when no report file could be read at all (so the
    caller can distinguish "no file" from "file present but empty"). Returns
    an empty list when a report file is present and parses but contains zero
    duplicates.
    """
    candidates = [
        report_dir / "jscpd-report.json",
        *report_dir.glob("**/jscpd-report.json"),
    ]
    seen: set[Path] = set()
    for path in candidates:
        if path in seen or not path.is_file():
            continue
        seen.add(path)
        try:
            data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        except (OSError, json.JSONDecodeError):
            continue
        duplicates = data.get("duplicates") or []
        return duplicates if isinstance(duplicates, list) else []
    return None


def format_duplicate(
    dup: dict, directory: Path,
) -> tuple[str, str, int, int] | None:
    """Extract (path1, path2, lines, tokens) from one jscpd duplicate record."""
    first = dup.get("firstFile") or {}
    second = dup.get("secondFile") or {}
    p1 = to_rel_posix(first.get("name", ""), directory)
    p2 = to_rel_posix(second.get("name", ""), directory)
    if not p1 or not p2:
        return None
    s1 = first.get("start") or first.get("startLoc", {}).get("line") or "?"
    e1 = first.get("end") or first.get("endLoc", {}).get("line") or "?"
    s2 = second.get("start") or second.get("startLoc", {}).get("line") or "?"
    e2 = second.get("end") or second.get("endLoc", {}).get("line") or "?"
    lines = int(dup.get("lines") or 0)
    tokens = int(dup.get("tokens") or 0)
    return (f"{p1}:{s1}-{e1}", f"{p2}:{s2}-{e2}", lines, tokens)


def _count_unique_files(pairs: list[tuple[str, str, int, int]]) -> int:
    """Count unique file paths in a list of duplicate pairs."""
    seen: set[str] = set()
    for a, b, _lines, _tokens in pairs:
        seen.add(_extract_filepath(a))
        seen.add(_extract_filepath(b))
    return len(seen)


def _print_bucket_summary(
    pairs: list[tuple[str, str, int, int]],
    shown_count: int,
    max_findings: int,
) -> None:
    """Print a compact line-bucket summary for pairs beyond the cap."""
    remainder = pairs[shown_count:]
    buckets: dict[str, int] = {}
    for _a, _b, lines, _tokens in remainder:
        if lines >= 50:
            key = "50+L"
        elif lines >= 20:
            key = "20-49L"
        else:
            key = "<20L"
        buckets[key] = buckets.get(key, 0) + 1
    parts = [f"{v} {k}" for k, v in sorted(buckets.items(), reverse=True)]
    print(f"  ... {len(remainder)} more: {', '.join(parts)}")


def print_duplicates(
    duplicates: list[dict], directory: Path, max_findings: int,
    show_generated: bool = False,
) -> int:
    """Print duplicate findings in a compact, agent-friendly format.

    Cross-file duplicates are listed individually.  Same-file duplicates are
    grouped by file with block counts and total lines.  Generated-file
    duplicates are shown as a one-line size summary by default.

    Returns the total number of duplicate pairs found (across all categories).
    Returns 0 when no duplicates exist or none could be formatted.
    """
    if not duplicates:
        print("=== Cross-file duplicates \u2014 none ===")
        print("=== Same-file duplicates \u2014 none ===")
        return 0

    # Sort by line count descending (worst-first), tie-break on tokens desc.
    pairs: list[tuple[str, str, int, int]] = []
    for dup in duplicates:
        formatted = format_duplicate(dup, directory)
        if formatted is not None:
            pairs.append(formatted)
    pairs.sort(key=lambda p: (p[2], p[3]), reverse=True)

    # Classify pairs into three categories.
    cross_file: list[tuple[str, str, int, int]] = []
    same_file: list[tuple[str, str, int, int]] = []
    generated: list[tuple[str, str, int, int]] = []

    for pair in pairs:
        a, b, lines, tokens = pair
        a_path = _extract_filepath(a)
        b_path = _extract_filepath(b)
        if _is_generated_path(a_path) or _is_generated_path(b_path):
            generated.append(pair)
        elif a_path == b_path:
            same_file.append(pair)
        else:
            cross_file.append(pair)

    total = len(pairs)

    # --- Cross-file: one line per pair ---
    if cross_file:
        print(f"=== Cross-file duplicates \u2014 {len(cross_file)} ===")
        shown = cross_file[:max_findings] if max_findings > 0 else cross_file
        for a, b, lines, tokens in shown:
            print(f"  {a} ~ {b}  {lines}L {tokens}T")
        remaining = len(cross_file) - len(shown)
        if remaining > 0:
            _print_bucket_summary(cross_file, len(shown), max_findings)
    else:
        print("=== Cross-file duplicates \u2014 none ===")

    # --- Same-file: grouped by file ---
    if same_file:
        print(f"=== Same-file duplicates \u2014 {len(same_file)} blocks in {_count_unique_files(same_file)} files ===")
        # Group by file path, sorted by total duplicated lines desc.
        file_groups: dict[str, list[tuple[str, str, int, int]]] = {}
        for pair in same_file:
            a_path = _extract_filepath(pair[0])
            file_groups.setdefault(a_path, []).append(pair)
        # Sort groups by total duplicated lines descending.
        sorted_groups = sorted(
            file_groups.items(),
            key=lambda item: sum(p[2] for p in item[1]),
            reverse=True,
        )
        shown_groups = sorted_groups[:max_findings] if max_findings > 0 else sorted_groups
        for filepath, group in shown_groups:
            total_lines = sum(p[2] for p in group)
            print(f"  {filepath}  {len(group)} blocks {total_lines}L")
        remaining = len(sorted_groups) - len(shown_groups)
        if remaining > 0:
            print(f"  ... {remaining} more files")
    else:
        print("=== Same-file duplicates \u2014 none ===")

    # --- Generated: conditional display ---
    if generated:
        if show_generated:
            buckets: dict[str, int] = {}
            for _a, _b, lines, _tokens in generated:
                if lines >= 50:
                    key = "50+L"
                elif lines >= 20:
                    key = "20-49L"
                else:
                    key = "<20L"
                buckets[key] = buckets.get(key, 0) + 1
            parts = [f"{v} {k}" for k, v in sorted(buckets.items(), reverse=True)]
            print(f"=== Generated-file duplicates \u2014 {len(generated)} ({', '.join(parts)}) ===")
        else:
            print(f"=== Generated-file duplicates \u2014 {len(generated)} (use --show-generated for details) ===")

    return total


def _locate_jscpd() -> list[str]:
    """Return the argv prefix for invoking jscpd via npx.

    jscpd is an npm package — not a Python dep, so the PEP 723 metadata
    can't install it. We invoke it via ``npx --yes jscpd`` which downloads
    the package on first use and caches it under ``~/.npm/_npx/``. This
    matches the convention used by analyze_complexity.py for Qualitas and
    means callers don't need to install anything beyond Node.js itself.
    """
    npx = _find_binary("npx")
    if npx is None:
        print(NPX_HINT, file=sys.stderr)
        sys.exit(2)
    # On Windows, ``npx`` is a ``.cmd`` shim and Python's subprocess does
    # not auto-resolve the ``.cmd`` extension when invoked with a list.
    # ``shutil.which`` returns the full path including the extension.
    return [npx, "--yes", "jscpd"]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_args() -> tuple[Path, int, int, int, bool, bool]:
    if len(sys.argv) >= 2 and sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)
    if len(sys.argv) < 2:
        print(
            "usage: find_duplicates.py <directory> "
            "[--max-findings N] [--min-lines N] [--min-tokens N] "
            "[--show-generated] [--exclude-test-directories]",
            file=sys.stderr,
        )
        sys.exit(2)

    directory = Path(sys.argv[1]).resolve()
    if not directory.is_dir():
        print(f"error: not a directory: {sys.argv[1]}", file=sys.stderr)
        sys.exit(2)

    max_findings = 50
    min_lines = 8
    min_tokens = 70
    show_generated = False
    exclude_test_dirs = False

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
        elif a == "--min-lines" and i + 1 < len(sys.argv):
            try:
                min_lines = int(sys.argv[i + 1])
            except ValueError:
                print("error: --min-lines must be an integer", file=sys.stderr)
                sys.exit(2)
            i += 2
        elif a == "--min-tokens" and i + 1 < len(sys.argv):
            try:
                min_tokens = int(sys.argv[i + 1])
            except ValueError:
                print("error: --min-tokens must be an integer", file=sys.stderr)
                sys.exit(2)
            i += 2
        elif a == "--show-generated":
            show_generated = True
            i += 1
        elif a == "--exclude-test-directories":
            exclude_test_dirs = True
            i += 1
        else:
            print(f"unknown argument: {a}", file=sys.stderr)
            sys.exit(2)

    if max_findings < 0:
        print("error: --max-findings must be >= 0", file=sys.stderr)
        sys.exit(2)
    if min_lines < 1 or min_tokens < 1:
        print("error: --min-lines and --min-tokens must be >= 1", file=sys.stderr)
        sys.exit(2)

    return (
        directory,
        max_findings,
        min_lines,
        min_tokens,
        show_generated,
        exclude_test_dirs,
    )


def main() -> None:
    (
        directory,
        max_findings,
        min_lines,
        min_tokens,
        show_generated,
        exclude_test_dirs,
    ) = parse_args()

    script_dir = Path(__file__).parent.resolve()
    global_patterns, context_patterns = load_ignore_patterns(script_dir)
    active_patterns = collect_active_ignore_patterns(
        directory, global_patterns, context_patterns,
    )

    jscpd_argv = _locate_jscpd()
    jscpd_ignore = _ignore_patterns_for_jscpd(active_patterns)
    duplicates = run_jscpd(
        directory, jscpd_argv, min_lines, min_tokens, jscpd_ignore,
    )
    if exclude_test_dirs:
        duplicates = [
            dup for dup in duplicates
            if not (
                _path_in_test_dir(dup.get("firstFile", {}).get("name", ""), directory)
                or _path_in_test_dir(dup.get("secondFile", {}).get("name", ""), directory)
            )
        ]
    print_duplicates(duplicates, directory, max_findings, show_generated=show_generated)


if __name__ == "__main__":
    main()