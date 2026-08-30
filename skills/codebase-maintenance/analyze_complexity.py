#!/usr/bin/env python3
"""
Analyze code complexity and structural quality via Qualitas.

Usage:
    python analyze_complexity.py <directory> [options]

    Walks the target directory respecting the shared .ignore file, stages a
    filtered temporary tree containing only source files Qualitas supports
    (TS/JS, Python, Rust, Go, Java), and scans that tree. Results are formatted
    for agent consumption.

Arguments:
    directory          Root directory to scan (required)
    --max-findings N   Maximum flagged functions to print (default: 50; 0 = unlimited)
    --min-grade GRADE  Only show functions with this grade or worse.
                       Grades: A (best), B, C, D, F (worst).
                       Default: C (shows C, D, F — skips A and B).

Output:
    One line per flagged function, sorted worst-first (lowest score first).
    Metrics are abbreviated to minimize token waste for agent consumption:

        src/handlers.ts:51 handleBackendRequest [F] 31 — cfc=100 he=50400 irc=1540

    Metric abbreviations: cfc=Cognitive flow complexity, he=Halstead effort,
    irc=Identifier reference complexity, nest=Maximum nesting depth,
    len=Function length (lines), params=Parameters, coupling=Coupling.

    If no flagged functions meet the grade filter: prints "no flagged functions".

Prerequisites:
    Node.js and npm must be available on PATH.  Qualitas is invoked via npx
    which downloads it on first use.  Supports TypeScript/JS, Python, Rust, Go,
    and Java.

    No Python dependencies beyond the standard library are required.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

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
is_skip_dir_name = _MOD.is_skip_dir_name

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
GRADE_ORDER = {"A": 0, "B": 1, "C": 2, "D": 3, "F": 4}
FLAG_SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}

# Short metric names for compact agent output.
METRIC_ABBREV: dict[str, str] = {
    "Cognitive flow complexity": "cfc",
    "Halstead effort": "he",
    "Halstead difficulty": "hd",
    "Identifier reference complexity": "irc",
    "Maximum nesting depth": "nest",
    "Function length": "len",
    "Function is": "len",          # "Function is 95 lines"
    "Function has": "params",       # "Function has 7 parameters"
    "Moderate coupling": "coupling",
}

# Qualitas only supports these languages.
QUALITAS_LANG_EXTENSIONS: frozenset[str] = frozenset({
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".pyw", ".pyi",
    ".rs",
    ".go",
    ".java",
})


# ---------------------------------------------------------------------------
# Filtered scan-tree staging (Qualitas has no exclusion option)
# ---------------------------------------------------------------------------

@contextmanager
def _stage_filtered_scan_tree(
    root: Path,
    active_patterns: list[str],
) -> Iterator[tuple[Path, list[str]]]:
    """Copy only eligible source files to an isolated temporary scan tree.

    Qualitas recursively traverses every directory it receives and currently
    exposes no reliable exclusion option.  Staging prevents ignored children
    at any depth from ever becoming visible to the tool, while preserving paths
    relative to *root* for report normalization.
    """
    with tempfile.TemporaryDirectory(prefix="qualitas-scan-") as tmp:
        stage_root = Path(tmp) / "scan"
        stage_root.mkdir()
        staged_files: list[str] = []

        def raise_walk_error(error: OSError) -> None:
            raise error

        for current, dir_names, file_names in os.walk(root, onerror=raise_walk_error):
            current_path = Path(current)
            kept_dirs: list[str] = []
            for name in dir_names:
                child = current_path / name
                rel_dir = child.relative_to(root).as_posix()
                if child.is_symlink() or is_skip_dir_name(name):
                    continue
                if matches_ignore_patterns(f"{rel_dir}/_", active_patterns):
                    continue
                kept_dirs.append(name)
            dir_names[:] = kept_dirs

            for name in file_names:
                source = current_path / name
                if source.is_symlink() or not source.is_file():
                    continue
                if source.suffix.lower() not in QUALITAS_LANG_EXTENSIONS:
                    continue
                rel_path = source.relative_to(root).as_posix()
                if matches_ignore_patterns(rel_path, active_patterns):
                    continue
                destination = stage_root / Path(rel_path)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
                staged_files.append(rel_path)

        yield stage_root, staged_files


# ---------------------------------------------------------------------------
# Qualitas invocation
# ---------------------------------------------------------------------------

class QualitasExecutionError(RuntimeError):
    """Raised when Qualitas did not produce a trustworthy report."""


def _run_qualitas_on_dir(directory: Path, npx_bin: str) -> dict:
    """Run Qualitas and return a valid JSON report, otherwise raise."""
    out_tmp = tempfile.NamedTemporaryFile(
        suffix=".json", prefix="qualitas-", delete=False,
    )
    out_path = out_tmp.name
    out_tmp.close()

    cmd = [npx_bin, "qualitas", str(directory), "-f", "json", "-o", out_path]

    try:
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
            )
        except subprocess.TimeoutExpired as exc:
            raise QualitasExecutionError(
                f"Qualitas timed out after 60 s while scanning {directory}"
            ) from exc
        except OSError as exc:
            raise QualitasExecutionError(
                f"could not run Qualitas for {directory}: {exc}"
            ) from exc

        diagnostic = (result.stderr or result.stdout).strip()[:500]
        if result.returncode != 0:
            suffix = f": {diagnostic}" if diagnostic else ""
            raise QualitasExecutionError(
                f"Qualitas failed for {directory} (exit {result.returncode}){suffix}"
            )

        report = Path(out_path)
        if not report.is_file() or report.stat().st_size == 0:
            raise QualitasExecutionError(
                f"Qualitas produced no report while scanning {directory}"
            )
        try:
            data = json.loads(report.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise QualitasExecutionError(
                f"Qualitas produced an unreadable or invalid JSON report for {directory}: {exc}"
            ) from exc
        if not isinstance(data, dict) or not data or not (
            isinstance(data.get("files"), list) or isinstance(data.get("filePath"), str)
        ):
            raise QualitasExecutionError(
                f"Qualitas produced an invalid report shape for {directory}"
            )
        return data
    finally:
        Path(out_path).unlink(missing_ok=True)


def run_qualitas(
    root: Path,
    source_dirs: list[Path],
) -> dict:
    """Run Qualitas on each source directory, merge results, and return."""
    npx_bin = shutil.which("npx")
    if npx_bin is None:
        print(
            "Error: npx not found in PATH.\n"
            "Node.js and npm are required. Install from https://nodejs.org/",
            file=sys.stderr,
        )
        sys.exit(2)

    if not source_dirs:
        print("no source directories found for qualitas analysis", file=sys.stderr)
        return {"files": []}

    merged_files: list[dict] = []

    for src_dir in source_dirs:
        data = _run_qualitas_on_dir(src_dir, npx_bin)

        # Normalise single-file and directory output shapes.
        if "files" in data:
            file_entries = data["files"]
        else:
            file_entries = [data]

        for fe in file_entries:
            # Qualitas may return filePaths relative to their scan dir or
            # absolute.  Normalise everything to a forward-slash relative
            # path so .ignore matching and output formatting are consistent.
            fp = fe.get("filePath", "")
            fe_path = Path(fp)
            if fe_path.is_absolute():
                try:
                    fe["filePath"] = fe_path.relative_to(root).as_posix()
                except ValueError:
                    fe["filePath"] = fe_path.as_posix()
            else:
                try:
                    fe["filePath"] = (src_dir / fp).relative_to(root).as_posix()
                except ValueError:
                    fe["filePath"] = PurePosixPath(Path(fp).as_posix()).as_posix()
            merged_files.append(fe)

    return {"files": merged_files}


# ---------------------------------------------------------------------------
# Result extraction and formatting
# ---------------------------------------------------------------------------

def extract_flagged_functions(
    data: dict,
    root: Path,
    active_patterns: list[str],
    min_grade: str,
) -> list[dict]:
    """Extract flagged functions from merged qualitas JSON."""
    min_grade_rank = GRADE_ORDER.get(min_grade, 2)
    flagged: list[dict] = []

    file_entries = data.get("files", [])

    for file_entry in file_entries:
        file_path: str = file_entry.get("filePath", "")

        # filePath was already made relative to root above.
        rel_path = file_path if file_path else ""

        # Apply .ignore patterns.
        if active_patterns and matches_ignore_patterns(rel_path, active_patterns):
            continue

        # Skip files whose extension qualitas doesn't support.
        # (Can happen if a source dir also contains config files, etc.)
        ext = Path(file_path).suffix.lower() if file_path else ""
        if ext and ext not in QUALITAS_LANG_EXTENSIONS:
            continue

        for fn in file_entry.get("functions", []):
            grade: str = fn.get("grade", "A")
            grade_rank = GRADE_ORDER.get(grade, 0)

            if grade_rank < min_grade_rank:
                continue

            flags = fn.get("flags", [])
            if not flags:
                continue

            flagged.append({
                "path": file_path,
                "rel_path": rel_path,
                "name": fn.get("name", "<anonymous>"),
                "line": fn.get("location", {}).get("startLine", "?"),
                "grade": grade,
                "score": fn.get("score", 0),
                "flags": flags,
            })

    return flagged


def _abbreviate_flag(msg: str) -> str:
    """Convert a verbose Qualitas flag message to a compact key=value form.

    Examples::

        "Cognitive flow complexity is 133 (threshold: 19)" → "cfc=133"
        "Function has 7 parameters (threshold: 7)"          → "params=7"
        "Moderate coupling: 11 imports, 0 distinct API calls" → "coupling=11imp/0api"
    """
    # Strip trailing threshold parenthetical, e.g. " (threshold: 19)"
    body = msg
    if " (threshold:" in body:
        body = body[: body.rfind(" (threshold:")]

    # Try to match a known metric prefix.
    for long_name, short in METRIC_ABBREV.items():
        if body.startswith(long_name):
            remainder = body[len(long_name):].strip()
            # "Function is 184 lines" → remainder = "184 lines"
            # "Function has 5 parameters" → remainder = "5 parameters"
            # "... is 133" → remainder = "133"
            # "...: 11 imports, ..." → remainder = "11 imports, ..."
            if remainder.startswith("is "):
                # "Cognitive flow complexity is 133"
                val_part = remainder[3:]
                num = val_part.split()[0]
                return f"{short}={num}"
            elif remainder.startswith("has "):
                # "Function has 7 parameters"
                num = remainder.split()[1] if len(remainder.split()) > 1 else remainder.split()[0]
                return f"{short}={num}"
            elif short == "coupling":
                # coupling: remainder like "11 imports, 0 distinct API calls"
                remainder = remainder.lstrip(": ")
                parts = remainder.split(",")
                imp = parts[0].strip().split()[0] if parts else "?"
                api = parts[1].strip().split()[0] if len(parts) > 1 else "?"
                return f"coupling={imp}imp/{api}api"
            else:
                # "Function is 184 lines" → prefix consumed "is", remainder = "184 lines"
                # "Function has 5 parameters" → prefix consumed "has", remainder = "5 parameters"
                # Extract leading number
                first_token = remainder.split()[0] if remainder else ""
                if first_token and first_token.replace('.', '').replace('-', '').replace('+', '').isdigit():
                    return f"{short}={first_token}"
                # Generic fallback
                return f"{short}={remainder}"

    # No known prefix — return as-is, stripped
    return body


def format_output(flagged: list[dict], max_findings: int) -> None:
    """Print flagged functions in a compact, agent-friendly format.

    One line per function with abbreviated metrics:

        path:line name [grade] score — cfc=133 he=1207k irc=1540
    """
    if not flagged:
        print("no flagged functions")
        return

    ranked = sorted(flagged, key=lambda f: f["score"])

    shown = ranked[:max_findings] if max_findings > 0 else ranked
    remaining = len(ranked) - len(shown)

    for f in shown:
        flags = sorted(
            f["flags"],
            key=lambda fl: FLAG_SEVERITY_ORDER.get(fl.get("severity", "info"), 3),
        )
        abbrevs = []
        for fl in flags:
            tag = _abbreviate_flag(fl.get("message", ""))
            if tag:
                abbrevs.append(tag)

        print(
            f"{f['rel_path']}:{f['line']} "
            f"{f['name']} [{f['grade']}] {f['score']:.0f} — "
            f"{' '.join(abbrevs)}"
        )

    if remaining > 0:
        grade_counts: dict[str, int] = {}
        for f in ranked[len(shown):]:
            g = f["grade"]
            grade_counts[g] = grade_counts.get(g, 0) + 1
        parts = [f"{v} {k}" for k, v in sorted(grade_counts.items())]
        print(f"... {remaining} more: {', '.join(parts)}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> tuple[Path, int, str]:
    if len(sys.argv) >= 2 and sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)
    if len(sys.argv) < 2:
        print(
            "usage: analyze_complexity.py <directory> "
            "[--max-findings N] [--min-grade GRADE]",
            file=sys.stderr,
        )
        sys.exit(2)

    directory = Path(sys.argv[1]).resolve()
    if not directory.is_dir():
        print(f"error: not a directory: {sys.argv[1]}", file=sys.stderr)
        sys.exit(2)

    max_findings = 50
    min_grade = "C"

    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == "--max-findings" and i + 1 < len(sys.argv):
            try:
                max_findings = int(sys.argv[i + 1])
            except ValueError:
                print("error: --max-findings must be an integer", file=sys.stderr)
                sys.exit(2)
            i += 2
        elif sys.argv[i] == "--min-grade" and i + 1 < len(sys.argv):
            grade = sys.argv[i + 1].upper()
            if grade not in GRADE_ORDER:
                print(
                    f"error: invalid grade '{grade}'. "
                    f"Must be one of: {', '.join(GRADE_ORDER)}",
                    file=sys.stderr,
                )
                sys.exit(2)
            min_grade = grade
            i += 2
        else:
            print(f"unknown argument: {sys.argv[i]}", file=sys.stderr)
            sys.exit(2)

    if max_findings < 0:
        print("error: --max-findings must be >= 0", file=sys.stderr)
        sys.exit(2)

    return directory, max_findings, min_grade


def main() -> None:
    directory, max_findings, min_grade = parse_args()

    # Load shared .ignore patterns
    script_dir = Path(__file__).parent.resolve()
    global_patterns, context_patterns = load_ignore_patterns(script_dir)
    active_patterns = collect_active_ignore_patterns(
        directory, global_patterns, context_patterns,
    )

    # Qualitas has no exclusion option, so expose only a filtered copy.  The
    # temporary tree is removed before formatting or returning.
    try:
        with _stage_filtered_scan_tree(directory, active_patterns) as (scan_root, staged_files):
            scan_targets = [scan_root] if staged_files else []
            data = run_qualitas(scan_root, scan_targets)
    except (OSError, QualitasExecutionError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(2)

    # Extract, filter, and print flagged functions.
    flagged = extract_flagged_functions(data, directory, active_patterns, min_grade)
    format_output(flagged, max_findings)


if __name__ == "__main__":
    main()