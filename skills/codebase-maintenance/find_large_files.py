#!/usr/bin/env python3
"""
Find code files exceeding a line count threshold, grouped by directory.

Usage:
    python find_large_files.py <directory> [max_lines]

Arguments:
    directory   Root directory to scan (required)
    max_lines   Line count threshold — files strictly over this are reported (default: 500)

Output:
    Files grouped by their containing directory (relative to the input directory's
    parent, so the root dir name is preserved). Within each directory, files are
    listed largest-first. Directories with no over-threshold files are omitted.
    All output goes to stdout; errors go to stderr.

Example:
    $ python find_large_files.py ./myproject 300
    myproject/src
    handlers.py 812loc
    models.py 401loc
    myproject/src/utils
    helpers.py 350loc
"""

import fnmatch
import os
import sys
from collections import defaultdict
from pathlib import Path, PurePosixPath

# ---------------------------------------------------------------------------
# Language extension registry
# ---------------------------------------------------------------------------
CODE_EXTENSIONS: frozenset[str] = frozenset({
    # Python
    ".py", ".pyw", ".pyi",
    # C / C++
    ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hxx", ".inl",
    # C#
    ".cs",
    # Java
    ".java",
    # JavaScript / TypeScript
    ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts",
    # Go
    ".go",
    # Rust
    ".rs",
    # Ruby
    ".rb", ".rake",
    # PHP
    ".php",
    # Swift
    ".swift",
    # Kotlin
    ".kt", ".kts",
    # Scala
    ".scala", ".sc",
    # R
    ".r",
    # Shell
    ".sh", ".bash", ".zsh", ".fish",
    # PowerShell
    ".ps1", ".psm1", ".psd1",
    # Perl
    ".pl", ".pm",
    # Lua
    ".lua",
    # Haskell
    ".hs", ".lhs",
    # Elixir / Erlang
    ".ex", ".exs", ".erl", ".hrl",
    # Clojure
    ".clj", ".cljs", ".cljc", ".edn",
    # F# / OCaml
    ".fs", ".fsx", ".fsi", ".ml", ".mli",
    # Dart
    ".dart",
    # Julia
    ".jl",
    # Objective-C
    ".m", ".mm",
    # Zig
    ".zig",
    # Nim
    ".nim",
    # Crystal
    ".cr",
    # D
    ".d",
    # SQL
    ".sql",
    # Assembly
    ".asm", ".s",
    # Visual Basic
    ".vb",
    # Groovy
    ".groovy", ".gvy",
    # Terraform / HCL
    ".tf", ".hcl",
    # MATLAB / Octave
    ".m",
})

# Directories that are never worth scanning
SKIP_DIRS: frozenset[str] = frozenset({
    ".git", ".hg", ".svn",
    "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".hypothesis", ".cache",
    "node_modules",
    "venv", ".venv", "env", ".env",
    "target",           # Rust / Maven build output
    "dist", "build", "out", ".next", ".nuxt", ".output",
    "vendor",           # Go / PHP vendored deps
    ".idea", ".vscode",
    "coverage", ".coverage",
    "eggs", ".eggs", "*.egg-info",
})

IGNORE_FILE_NAMES: tuple[str, ...] = (".ignore", ".codebase-ignore")


# ---------------------------------------------------------------------------
# Ignore-file loading
# ---------------------------------------------------------------------------


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


def normalize_path_token(value: str, *, strip_trailing_slash: bool) -> str:
    normalized = value.strip().replace("\\", "/")
    while "//" in normalized:
        normalized = normalized.replace("//", "/")
    if normalized.startswith("./"):
        normalized = normalized[2:]
    if strip_trailing_slash:
        normalized = normalized.rstrip("/")
    return normalized


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
# Core logic
# ---------------------------------------------------------------------------

def count_lines(path: Path) -> int:
    """Return the number of lines in *path*, or 0 on read error."""
    try:
        with open(path, encoding="utf-8", errors="ignore") as fh:
            return sum(1 for _ in fh)
    except OSError:
        return 0


def is_skip_dir_name(name: str) -> bool:
    """Return True when a directory name matches a native skip pattern."""
    return any(fnmatch.fnmatch(name, pattern) for pattern in SKIP_DIRS)


def is_skipped(file: Path, base: Path) -> bool:
    """Return True if a directory component matches ``SKIP_DIRS``."""
    try:
        rel_parts = file.relative_to(base).parts
    except ValueError:
        return False
    return any(is_skip_dir_name(part) for part in rel_parts[:-1])


def find_large_files(
    directory: Path, max_lines: int,
    global_patterns: list[str] | None = None,
    context_patterns: list[tuple[str, list[str]]] | None = None,
) -> dict[str, list[tuple[str, int]]]:
    """
    Recursively walk *directory* and return a mapping of:
        relative_dir_path -> [(filename, loc), ...]
    Only files with LOC strictly greater than *max_lines* are included.
    Within each directory, files are sorted largest-first.
    Directories are sorted alphabetically.
    """
    results: dict[str, list[tuple[str, int]]] = defaultdict(list)
    active_patterns = collect_active_ignore_patterns(
        directory,
        global_patterns or [],
        context_patterns or [],
    )

    for current, dir_names, file_names in os.walk(directory):
        current_path = Path(current)
        # Prune ignored/native-noise directories before descending into them.
        kept_dirs: list[str] = []
        for name in dir_names:
            child = current_path / name
            rel_dir = child.relative_to(directory).as_posix()
            if is_skip_dir_name(name):
                continue
            if matches_ignore_patterns(f"{rel_dir}/_", active_patterns):
                continue
            kept_dirs.append(name)
        dir_names[:] = kept_dirs

        for name in file_names:
            file = current_path / name
            if file.suffix.lower() not in CODE_EXTENSIONS:
                continue
            rel_path = file.relative_to(directory).as_posix()
            if matches_ignore_patterns(rel_path, active_patterns):
                continue

            loc = count_lines(file)
            if loc > max_lines:
                rel_dir = (
                    PurePosixPath(directory.name)
                    / PurePosixPath(file.parent.relative_to(directory).as_posix())
                ).as_posix()
                results[rel_dir].append((file.name, loc))

    return {
        d: sorted(files, key=lambda x: x[1], reverse=True)
        for d, files in sorted(results.items())
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> tuple[Path, int]:
    if len(sys.argv) >= 2 and sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)
    if len(sys.argv) < 2:
        print(
            "usage: find_large_files.py <directory> [max_lines]",
            file=sys.stderr,
        )
        sys.exit(1)

    directory = Path(sys.argv[1]).resolve()
    if not directory.is_dir():
        print(f"error: not a directory: {sys.argv[1]}", file=sys.stderr)
        sys.exit(1)

    max_lines = 500
    if len(sys.argv) >= 3:
        try:
            max_lines = int(sys.argv[2])
            if max_lines < 0:
                raise ValueError
        except ValueError:
            print(
                "error: max_lines must be a non-negative integer", file=sys.stderr
            )
            sys.exit(1)

    return directory, max_lines


def main() -> None:
    directory, max_lines = parse_args()
    script_dir = Path(__file__).parent.resolve()
    global_patterns, context_patterns = load_ignore_patterns(script_dir)
    results = find_large_files(directory, max_lines, global_patterns, context_patterns)

    if not results:
        # Single-line signal that agents can pattern-match on
        print(f"none >{max_lines}loc")
        return

    for rel_dir, files in results.items():
        print(rel_dir)
        for name, loc in files:
            print(f"{name} {loc}loc")


if __name__ == "__main__":
    main()
