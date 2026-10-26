"""Explicit scanner selection only; provisioning/version identity belongs to setup."""

from pathlib import Path


def prepared_argv(
    node_executable: str | None = None,
    scanner_entry: str | None = None,
) -> list[str] | None:
    """Validate an explicit Node/JS pair, or return None for the legacy route.

    This checks invocation paths, not versions, payload integrity or readiness.
    Never discover tools, download packages, or fall back from a bad selection.
    """
    if node_executable is None and scanner_entry is None:
        return None
    if not node_executable or not scanner_entry:
        raise ValueError("prepared mode requires both --node-executable and --scanner-entry")
    for label, value in (("Node executable", node_executable), ("scanner entry", scanner_entry)):
        path = Path(value)
        if not path.is_absolute() or not path.is_file():
            raise ValueError(f"prepared {label} must be an existing absolute file: {value}")
    if Path(scanner_entry).suffix.lower() not in (".js", ".cjs", ".mjs"):
        raise ValueError("prepared scanner entry must be a JavaScript file (.js, .cjs or .mjs)")
    return [node_executable, scanner_entry]


def parse_prepared_args(argv: list[str]) -> tuple[list[str], list[str] | None]:
    """Remove the shared CLI pair, leaving the scanner's existing arguments."""
    remaining: list[str] = []
    selected: dict[str, str] = {}
    i = 0
    while i < len(argv):
        option = argv[i]
        if option in ("--node-executable", "--scanner-entry"):
            if option in selected:
                raise ValueError(f"duplicate prepared option: {option}")
            if i + 1 == len(argv) or argv[i + 1].startswith("--"):
                raise ValueError(f"missing value for {option}")
            selected[option] = argv[i + 1]
            i += 2
        else:
            remaining.append(option)
            i += 1
    return remaining, prepared_argv(selected.get("--node-executable"), selected.get("--scanner-entry"))
