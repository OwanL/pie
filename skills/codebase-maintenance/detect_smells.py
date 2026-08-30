#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "semgrep",
# ]
# ///
"""
Detect code smells and potential bugs via semgrep static analysis.

Usage:
    uv run detect_smells.py <directory> [--max-findings N] [--rules CONFIG]

Analyzes source files using semgrep and reports findings in a concise,
agent-friendly format. Filters results using the shared .ignore file (see
find_large_files.py for format details).

Arguments:
    directory            Root directory to scan (required)
    --max-findings N     Maximum findings to print (default: 50; 0 = unlimited)
    --rules CONFIG       Semgrep config: rule-set name or local path
                         (default: p/default — community rules, no login needed)
    --exclude-categories CATEGORIES
                         Comma-separated categories to exclude from output
                         (default: security — known false-positive-heavy
                         community rules)
                         Findings whose extra.metadata.category matches one
                         of these are dropped.  Findings without a category
                         are kept.

Output:
    One line per finding, sorted worst-first:

        path/to/file.py:42 [WARNING] Variable 'x' may be null

    If findings exceed --max-findings a one-line summary of the remainder is
    printed.  If no findings: prints "no findings".

Exit codes:
    0  no findings, or findings only (semgrep exit 1 is remapped to 0)
    2  semgrep itself errored
"""

import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Re-use the shared ignore-file logic from find_large_files.py
# ---------------------------------------------------------------------------
_MODULE_PATH = Path(__file__).parent / "find_large_files.py"
try:
    _SPEC = importlib.util.spec_from_file_location("_find_large_files", _MODULE_PATH)
    _MOD = importlib.util.module_from_spec(_SPEC)  # type: ignore[arg-type]
    _SPEC.loader.exec_module(_MOD)  # type: ignore[union-attr]
except (FileNotFoundError, AttributeError) as exc:
    print(f"Error: could not load {_MODULE_PATH}: {exc}", file=sys.stderr)
    sys.exit(2)

load_ignore_patterns = _MOD.load_ignore_patterns
collect_active_ignore_patterns = _MOD.collect_active_ignore_patterns
matches_ignore_patterns = _MOD.matches_ignore_patterns

# ---------------------------------------------------------------------------
# Severity ranking (worst first)
# ---------------------------------------------------------------------------
SEVERITY_ORDER: dict[str, int] = {
    "CRITICAL": 0,
    "ERROR": 1,
    "HIGH": 2,
    "WARNING": 3,
    "MEDIUM": 4,
    "LOW": 5,
    "INFO": 6,
    "EXPERIMENT": 7,
    "INVENTORY": 7,
}


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

def _exclude_patterns_for_semgrep(active_patterns: list[str]) -> list[str]:
    """Translate shared ignores to Semgrep's Windows-safe exclusions.

    Semgrep's current ``--exclude`` syntax already treats a slash-free pattern
    as an any-depth basename and a pattern containing a slash as scan-root
    relative.  Passing explicit ``**/`` or ``/**`` forms is unnecessary and
    crashes some Windows Semgrep releases in ``Glob__Lexer``.  Standard outer
    globstars are reduced to the equivalent native form; patterns with an
    interior globstar have no safe equivalent and are left to the mandatory
    result post-filter rather than passed to Semgrep.
    """
    excludes: list[str] = []
    for pattern in active_patterns:
        normalized = pattern.strip().replace("\\", "/")
        if normalized.startswith("./"):
            normalized = normalized[2:]
        normalized = normalized.rstrip("/")
        had_leading_globstar = False
        while normalized.startswith("**/"):
            had_leading_globstar = True
            normalized = normalized[3:]
        if normalized.endswith("/**"):
            candidate = normalized[:-3].rstrip("/")
            # ``src/**`` is root-only, but ``src`` is any-depth in Semgrep.
            # Omit that unsafe translation and let result filtering handle it.
            if "/" not in candidate and not had_leading_globstar:
                continue
            normalized = candidate
        if "**" in normalized:
            continue
        if normalized and normalized not in excludes:
            excludes.append(normalized)
    return excludes


def run_semgrep(
    directory: Path,
    rules: str,
    active_patterns: list[str] | None = None,
) -> dict:
    """Run ``semgrep scan`` and return JSON, retaining any failure status."""
    semgrep_bin = shutil.which("semgrep")
    if semgrep_bin is None:
        print(
            "Error: semgrep not found in PATH.\n"
            "Run from this skill directory via: uv run detect_smells.py <directory>\n"
            "The PEP 723 metadata in this script declares semgrep as a dependency — "
            "uv run will install it automatically.",
            file=sys.stderr,
        )
        sys.exit(2)

    cmd = [
        semgrep_bin,
        "scan",
        "--json",
        "--metrics", "off",
        "--config", rules,
    ]
    for pattern in _exclude_patterns_for_semgrep(active_patterns or []):
        cmd += ["--exclude", pattern]
    cmd.append(str(directory))

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        print("Error: semgrep scan timed out after 300 s", file=sys.stderr)
        sys.exit(2)
    except OSError as exc:
        print(f"Error: could not run semgrep: {exc}", file=sys.stderr)
        sys.exit(2)

    # semgrep exit 0 = no findings, exit 1 = findings (not an error).
    execution_error = result.returncode >= 2
    if execution_error:
        print(
            f"semgrep error (exit {result.returncode}): "
            f"{result.stderr.strip()[:500]}",
            file=sys.stderr,
        )

    if not result.stdout.strip():
        if execution_error:
            sys.exit(result.returncode)
        return {"results": [], "errors": []}

    try:
        data = json.loads(result.stdout)
        if not isinstance(data, dict):
            raise json.JSONDecodeError("expected a JSON object", result.stdout, 0)
        if execution_error:
            # Let main print partial findings and structured diagnostics before
            # propagating the tool's nonzero status.
            data["_execution_exit_code"] = result.returncode
        return data
    except json.JSONDecodeError:
        print("Error: semgrep produced invalid JSON output", file=sys.stderr)
        sys.exit(2)


def filter_results(
    results: list[dict],
    directory: Path,
    active_patterns: list[str],
) -> list[dict]:
    """Remove findings whose file path matches an ignore pattern."""
    if not active_patterns:
        return results

    kept: list[dict] = []
    for r in results:
        raw_path: str = r.get("path", "")
        try:
            rel_path = Path(raw_path).relative_to(directory).as_posix()
        except ValueError:
            # Path is not under directory — keep it (unlikely but safe).
            rel_path = raw_path
        if not matches_ignore_patterns(rel_path, active_patterns):
            kept.append(r)
    return kept


def filter_categories(
    results: list[dict],
    exclude_categories: set[str],
) -> list[dict]:
    """Remove findings whose category is in the exclusion set.

    Categories are read from ``finding["extra"]["metadata"]["category"]"``.
    Findings that have no category field are **kept** — only an explicit
    match causes exclusion.
    """
    if not exclude_categories:
        return results

    kept: list[dict] = []
    for r in results:
        category = r.get("extra", {}).get("metadata", {}).get("category")
        if category is not None and category in exclude_categories:
            continue
        kept.append(r)
    return kept


def format_findings(results: list[dict], directory: Path, max_findings: int) -> None:
    """Print findings in a concise, agent-friendly format."""
    if not results:
        print("no findings")
        return

    ranked = sorted(
        results,
        key=lambda r: SEVERITY_ORDER.get(
            r.get("extra", {}).get("severity", "INFO"), 8
        ),
    )

    shown = ranked[:max_findings] if max_findings > 0 else ranked
    remaining = len(ranked) - len(shown)

    for r in shown:
        raw_path: str = r.get("path", "")
        try:
            rel_path = Path(raw_path).relative_to(directory).as_posix()
        except ValueError:
            rel_path = Path(raw_path).name

        line = r.get("start", {}).get("line", "?")
        severity = r.get("extra", {}).get("severity", "INFO")
        message = r.get("extra", {}).get("message", r.get("check_id", ""))
        if len(message) > 200:
            # Try to break at a word boundary
            cut = message.rfind(" ", 0, 197)
            if cut == -1:
                cut = 197
            message = message[:cut] + "..."

        print(f"{rel_path}:{line} [{severity}] {message}")

    if remaining > 0:
        totals: dict[str, int] = {}
        for r in ranked[len(shown):]:
            sev = r.get("extra", {}).get("severity", "INFO")
            totals[sev] = totals.get(sev, 0) + 1
        parts = [f"{v} {k.lower()}" for k, v in sorted(totals.items())]
        print(f"... {remaining} more finding(s): {', '.join(parts)}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> tuple[Path, int, str, set[str]]:
    if len(sys.argv) >= 2 and sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)
    if len(sys.argv) < 2:
        print(
            "usage: detect_smells.py <directory> "
            "[--max-findings N] [--rules CONFIG] [--exclude-categories CATEGORIES]",
            file=sys.stderr,
        )
        sys.exit(2)

    directory = Path(sys.argv[1]).resolve()
    if not directory.is_dir():
        print(f"error: not a directory: {sys.argv[1]}", file=sys.stderr)
        sys.exit(2)

    max_findings = 50
    rules = "p/default"
    exclude_categories: set[str] = {"security"}

    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == "--max-findings" and i + 1 < len(sys.argv):
            try:
                max_findings = int(sys.argv[i + 1])
            except ValueError:
                print("error: --max-findings must be an integer", file=sys.stderr)
                sys.exit(2)
            i += 2
        elif sys.argv[i] == "--rules" and i + 1 < len(sys.argv):
            rules = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == "--exclude-categories" and i + 1 < len(sys.argv):
            exclude_categories = set(c for c in sys.argv[i + 1].split(",") if c)
            i += 2
        else:
            print(f"unknown argument: {sys.argv[i]}", file=sys.stderr)
            sys.exit(2)

    if max_findings < 0:
        print("error: --max-findings must be >= 0", file=sys.stderr)
        sys.exit(2)

    return directory, max_findings, rules, exclude_categories


def main() -> None:
    directory, max_findings, rules, exclude_categories = parse_args()

    # Load the shared .ignore patterns (same convention as find_large_files.py).
    script_dir = Path(__file__).parent.resolve()
    global_patterns, context_patterns = load_ignore_patterns(script_dir)
    active_patterns = collect_active_ignore_patterns(
        directory, global_patterns, context_patterns,
    )

    data = run_semgrep(directory, rules, active_patterns)

    # Guard against semgrep returning null instead of []  (see: JSON null)
    results: list[dict] = data.get("results") or []
    errors: list[dict] = data.get("errors") or []

    results = filter_results(results, directory, active_patterns)
    results = filter_categories(results, exclude_categories)
    format_findings(results, directory, max_findings)

    if errors:
        for err in errors[:5]:  # cap at 5 to avoid flooding stderr
            epath = err.get("path", "<unknown>")
            try:
                epath = Path(epath).relative_to(directory).as_posix()
            except ValueError:
                pass
            emsg = err.get("message", "") or err.get("short_msg", "") or ""
            if len(emsg) > 120:
                emsg = emsg[:117] + "..."
            print(f"semgrep: {epath}: {emsg}", file=sys.stderr)
        if len(errors) > 5:
            print(f"... {len(errors) - 5} more error(s)", file=sys.stderr)

    execution_exit = data.get("_execution_exit_code")
    if execution_exit is not None:
        sys.exit(int(execution_exit))
    if errors:
        # Structured Semgrep errors mean the scan was incomplete even when the
        # process happened to exit zero.
        sys.exit(2)


if __name__ == "__main__":
    main()
