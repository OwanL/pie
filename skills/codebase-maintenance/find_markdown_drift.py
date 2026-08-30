#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "requests",
# ]
# ///
"""
Find markdown files and check for document drift — stale internal references
and broken external URLs.

Usage:
    uv run find_markdown_drift.py <directory> [options]

Recursively finds all ``.md`` / ``.mdx`` files under *directory*, then checks
every reference found in each document:

- **Internal file references** — relative paths (with optional ``#anchor``)
  are resolved against the document's directory.  Missing files or anchors
  that don't exist in the target document are counted as broken.

- **External URLs** — ``http://`` and ``https://`` links are fetched with a
  HEAD request (falling back to GET).  Any non-2xx/3xx response counts as
  broken.  Private/local targets (``localhost``, loopback, RFC1918,
  link-local, ...) are never fetched, including as redirect destinations:
  redirects are followed manually and each hop is re-verified first.

Output is sorted by the file's last-modified timestamp (oldest first) so
that the most stale documents surface at the top.

Respects the shared ``.ignore`` file (see ``find_large_files.py`` for format
details).

Arguments:
    directory              Root directory to scan (required)
    --timeout SECONDS      HTTP request timeout per URL (default: 10)
    --max-urls N           Maximum external URLs to check across the whole
                          scan (default: 200; 0 = unlimited; negative values
                          are rejected).  When the limit is hit, remaining
                          URLs are reported as ``skipped``.
    --skip-external        Skip all external URL checks (only check internal
                          references).
    --check-anchors        Validate ``#anchor`` fragments against the target
                          file's heading IDs (adds overhead for large docs).
    -v, --verbose          Print each reference as it is checked.

Output:
    Tabular listing sorted by last-modified time (oldest first):

        === Markdown document drift ===
        path/to/old-doc.md        3 broken refs   modified 2024-01-15
        path/to/recent-doc.md     0 broken refs   modified 2024-11-02
        ...

    Followed by a detail section listing every broken reference per file:

        --- Broken references ---
        path/to/old-doc.md
          [internal] ./missing-file.md (file not found)
          [internal] ./README.md#removed-section (anchor not found)
          [external] https://example.com/dead (HTTP 404)
        ...

    If no markdown files are found, prints ``no markdown files found``.
"""

from __future__ import annotations

import argparse
import fnmatch
import ipaddress
import os
import re
import socket
import string
import sys
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from collections.abc import Callable, Iterable, Iterator
from pathlib import Path, PurePosixPath
from urllib.parse import urljoin, urlparse

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MARKDOWN_EXTENSIONS: frozenset[str] = frozenset({".md", ".mdx"})

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

# Finds the label and opening parenthesis of an inline link/image. Destination
# parsing is stateful below so balanced parentheses are handled correctly.
_INLINE_LINK_OPEN_RE = re.compile(r"(?<!\\)!?\[(?:\\.|[^\]\\\n])*\]\(")
_ESCAPABLE_PUNCTUATION: frozenset[str] = frozenset(string.punctuation)

# Matches the ``#anchor`` fragment at the end of a path.
_ANCHOR_RE = re.compile(r"#(.+)$")

# Matches markdown ATX headings and converts them to plausible anchor IDs
# (GitHub-style: lowercase, spaces→hyphens, strip punctuation).
_HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+\s*)?$", re.MULTILINE)

# Matches Setext heading underlines (a line of ``=`` or ``-`` following a
# paragraph line).  Matched against the stripped line.
_SETEXT_UNDERLINE_RE = re.compile(r"^(=+|-+)$")

# Matches the start of a link reference definition (``[label]: ...``), used to
# keep such lines from being mistaken for Setext heading paragraphs.
_LINK_DEF_START_RE = re.compile(r"^\s{0,3}\[[^\]]*\]:")

# Matches reference-style link usages: full ``[text][label]``, collapsed
# ``[label][]``, and shortcut ``[label]``.  The negative lookahead keeps
# inline links (``[text](url)``) from matching the first bracket as a
# shortcut reference.
_REF_USAGE_RE = re.compile(
    r"""
    (?<!\\)                             # not escaped
    \[([^\]\[]*)\]                      # first bracket: link text / shortcut label
    (?:\[([^\]\[]*)\])?                 # optional second bracket: reference label
    (?![ \t]*\()                        # not an inline link's opening paren
    """,
    re.VERBOSE,
)


# ---------------------------------------------------------------------------
# Ignore-file loading  (mirrors find_large_files.py)
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
    normalized_context = normalize_path_token(context_path, strip_trailing_slash=True)
    if not normalized_context:
        return False
    normalized_root = normalize_path_token(
        scan_root.resolve().as_posix(), strip_trailing_slash=True,
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
    path_parts = [p for p in PurePosixPath(normalized_path).parts if p not in ("", ".")]
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
        if any(fnmatch.fnmatch(dp, directory_pattern) for dp in dir_paths):
            return True
        if "/" not in directory_pattern:
            return any(fnmatch.fnmatch(part, directory_pattern) for part in path_parts[:-1])
        return False
    if fnmatch.fnmatch(normalized_path, normalized_pattern):
        return True
    if fnmatch.fnmatch(basename, normalized_pattern):
        return True
    if any(fnmatch.fnmatch(dp, normalized_pattern) for dp in dir_paths):
        return True
    if "/" not in normalized_pattern:
        return any(fnmatch.fnmatch(part, normalized_pattern) for part in path_parts)
    return False


def matches_ignore_patterns(file_rel_path: str, active_patterns: list[str]) -> bool:
    return any(matches_ignore_pattern(file_rel_path, p) for p in active_patterns)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def is_skipped(file: Path, base: Path) -> bool:
    try:
        rel_parts = file.relative_to(base).parts
    except ValueError:
        return False
    return any(
        fnmatch.fnmatch(part, pattern)
        for part in rel_parts[:-1]
        for pattern in SKIP_DIRS
    )


def strip_code_blocks(content: str) -> str:
    """Remove fenced code blocks and inline code spans from markdown content.

    This prevents false-positive link detection inside code examples.
    Fenced blocks are replaced with blank lines to preserve line numbering;
    inline code spans are replaced with spaces.
    """
    # Remove fenced code blocks (``` or ~~~)
    # Process line-by-line to avoid complex regex backtracking.
    lines = content.split("\n")
    in_fence = False
    fence_marker = ""
    result_lines: list[str] = []
    for raw_line in lines:
        line = raw_line.rstrip("\r")  # tolerate CRLF line endings
        stripped = line.lstrip()
        if not in_fence:
            # Check for opening fence (3+ backticks or tildes, optional info string)
            fence_match = re.match(r"^[ \t]{0,3}(`{3,}|~{3,})", line)
            if fence_match:
                in_fence = True
                fence_marker = fence_match.group(1)[0]  # ` or ~
                fence_len = len(fence_match.group(1))
                result_lines.append("")
            else:
                result_lines.append(line)
        else:
            # Check for closing fence (same character, at least as many)
            close_match = re.match(r"^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$", line)
            if close_match and close_match.group(1)[0] == fence_marker and len(close_match.group(1)) >= fence_len:
                in_fence = False
                result_lines.append("")
            else:
                result_lines.append("")  # blank out code content
    result = "\n".join(result_lines)
    # Remove inline code spans (backtick-delimited)
    result = re.sub(r"(`+)(?!`)(.+?)(?<!`)\1(?!`)", lambda m: " " * len(m.group(0)), result)
    return result


# ---------------------------------------------------------------------------
# Reference extraction
# ---------------------------------------------------------------------------


def normalize_reference(ref: str) -> str:
    """Normalize *ref*: protocol-relative ``//host/...`` becomes ``https://``."""
    if ref.startswith("//"):
        return f"https:{ref}"
    return ref


def _normalize_link_label(label: str) -> str:
    """Normalize a link label per CommonMark: whitespace-collapsed, case-folded."""
    return " ".join(label.split()).casefold()


def _finish_inline_link(content: str, index: int) -> int | None:
    """Return the index after an inline link's closing ``)``, if valid."""
    if index < len(content) and content[index] == ")":
        return index + 1
    if index >= len(content) or not content[index].isspace():
        return None
    while index < len(content) and content[index].isspace():
        index += 1
    if index < len(content) and content[index] == ")":
        return index + 1
    if index >= len(content) or content[index] not in "\"'(":
        return None

    opener = content[index]
    closer = {"\"": "\"", "'": "'", "(": ")"}[opener]
    index += 1
    while index < len(content):
        char = content[index]
        if (
            char == "\\"
            and index + 1 < len(content)
            and content[index + 1] in _ESCAPABLE_PUNCTUATION
        ):
            index += 2
            continue
        if char == closer:
            index += 1
            break
        index += 1
    else:
        return None

    while index < len(content) and content[index].isspace():
        index += 1
    return index + 1 if index < len(content) and content[index] == ")" else None


def _parse_inline_destination(content: str, index: int) -> tuple[str, int] | None:
    """Parse one CommonMark inline-link destination starting at *index*.

    Bare destinations may contain escaped characters and balanced parentheses;
    angle-bracket destinations may contain whitespace.  The returned end index
    is immediately after the link's closing parenthesis.
    """
    while index < len(content) and content[index].isspace():
        index += 1
    if index >= len(content):
        return None
    if content[index] == ")":
        return "", index + 1

    destination: list[str] = []
    if content[index] == "<":
        index += 1
        while index < len(content):
            char = content[index]
            if (
                char == "\\"
                and index + 1 < len(content)
                and content[index + 1] in _ESCAPABLE_PUNCTUATION
            ):
                destination.append(content[index + 1])
                index += 2
                continue
            if char == ">":
                end = _finish_inline_link(content, index + 1)
                return ("".join(destination), end) if end is not None else None
            if char in "<\r\n":
                return None
            destination.append(char)
            index += 1
        return None

    depth = 0
    while index < len(content):
        char = content[index]
        if (
            char == "\\"
            and index + 1 < len(content)
            and content[index + 1] in _ESCAPABLE_PUNCTUATION
        ):
            destination.append(content[index + 1])
            index += 2
            continue
        if char == "(":
            depth += 1
            destination.append(char)
            index += 1
            continue
        if char == ")":
            if depth == 0:
                return "".join(destination), index + 1
            depth -= 1
            destination.append(char)
            index += 1
            continue
        if char.isspace():
            if depth != 0:
                return None
            end = _finish_inline_link(content, index)
            return ("".join(destination), end) if end is not None else None
        if ord(char) < 0x20 or ord(char) == 0x7F:
            return None
        destination.append(char)
        index += 1
    return None


def _extract_inline_destinations(content: str) -> list[str]:
    """Extract valid inline link/image destinations in source order."""
    destinations: list[str] = []
    position = 0
    while match := _INLINE_LINK_OPEN_RE.search(content, position):
        parsed = _parse_inline_destination(content, match.end())
        if parsed is None:
            position = match.end()
            continue
        destination, position = parsed
        if destination:
            destinations.append(destination)
    return destinations


def _extract_reference_definitions(content: str) -> dict[str, str]:
    """Extract reference-style link definitions from markdown content.

    Parses lines like ``[id]: url`` or ``[id]: <url>`` and returns a mapping
    of ``{label: url}``.
    """
    definitions: dict[str, str] = {}
    # Reference definitions: [label]: <url> or [label]: url  (with optional title)
    _REF_DEF_RE = re.compile(
        r"""^\s{0,3}\[([^\]]+)\]:\s+(?:<([^>]+)>|([^\s]+))(?:\s+(?:'[^']*'|\"[^\"]*\"|\([^)]*\)))?\s*$""",
        re.MULTILINE,
    )
    for m in _REF_DEF_RE.finditer(content):
        label = _normalize_link_label(m.group(1))
        url = (m.group(2) or m.group(3) or "").strip()
        if label and url:
            # CommonMark specifies that the first matching definition wins.
            definitions.setdefault(label, url)
    return definitions


def extract_references(content: str) -> list[str]:
    """Extract all link/image destinations from markdown *content*.

    Covers inline links/images (with ``<...>``, bare, double- and single-
    quoted titles), reference-style links (full ``[text][label]``, collapsed
    ``[label][]``, shortcut ``[label]``), link reference definitions, and
    autolinks.  Protocol-relative URLs are normalized to ``https://`` and
    the result is de-duplicated preserving first-seen order.
    """
    cleaned = strip_code_blocks(content)
    definitions = _extract_reference_definitions(cleaned)
    refs = _extract_inline_destinations(cleaned)
    # Reference-style usages resolved through their definitions
    for match in _REF_USAGE_RE.finditer(cleaned):
        first, second = match.group(1), match.group(2)
        label = second if second else first
        if not label:
            continue
        url = definitions.get(_normalize_link_label(label))
        if url:
            refs.append(url)
    # All defined URLs are checked even when unreferenced (drift detection)
    refs.extend(definitions.values())
    # Extract autolinks: <https://example.com> (CommonMark §6.6)
    _AUTOLINK_RE = re.compile(r"<(https?://[^>]+)>")
    for m in _AUTOLINK_RE.finditer(cleaned):
        url = m.group(1).strip()
        if url:
            refs.append(url)
    refs = [normalize_reference(r) for r in refs]
    # De-duplicate, preserving first-seen order (repeated links share one check)
    seen: set[str] = set()
    unique: list[str] = []
    for ref in refs:
        if ref not in seen:
            seen.add(ref)
            unique.append(ref)
    return unique


def classify_reference(ref: str, *, check_anchors: bool = False) -> str:
    """Return ``'external'``, ``'internal'``, ``'anchor'``, or ``'skip'``.

    When *check_anchors* is True, same-document anchors (``#heading``) are
    classified as ``'anchor'`` so they can be validated. Otherwise they are
    skipped.
    """
    lower = ref.lower()
    # Scheme-based classification
    if lower.startswith(("http://", "https://")):
        # Never fetch private/local targets (loopback, RFC1918, link-local, ...)
        if is_private_or_local_target(ref):
            return "skip"
        return "external"
    # Pure anchors within the same document
    if ref.startswith("#"):
        return "anchor" if check_anchors else "skip"
    # Protocol-relative
    if ref.startswith("//"):
        return "external"
    # Mailto, tel, data URIs
    if re.match(r"^(mailto:|tel:|data:|javascript:)", ref, re.IGNORECASE):
        return "skip"
    return "internal"


def parsed_hostname(url: str) -> str:
    try:
        return urlparse(url).hostname or ""
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Private / local target protection
# ---------------------------------------------------------------------------

# Hostnames that always resolve to the local machine.
_LOCAL_HOSTNAMES: frozenset[str] = frozenset({
    "localhost", "broadcasthost", "ip6-localhost", "ip6-loopback",
})

# Top-level domains reserved for local / private name resolution.
_LOCAL_TLDS: frozenset[str] = frozenset({"localhost", "local", "internal"})


def _ip_is_private(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address):
        mapped = ip.ipv4_mapped
        if mapped is not None:
            ip = mapped  # ::ffff:127.0.0.1 etc. must be judged as IPv4
    return bool(
        not ip.is_global
        or ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_unspecified
        or ip.is_reserved
        or ip.is_multicast
    )


def is_private_or_local_target(url: str) -> bool:
    """Return True for syntactically private/local targets without DNS.

    Covers loopback/private/link-local/unspecified/reserved/multicast literal
    IPs (including IPv4-mapped IPv6), local hostnames, and ``.localhost`` /
    ``.local`` / ``.internal`` domains.  DNS hostnames are resolved by
    :func:`_request_target_rejection` immediately before every request.
    """
    try:
        parsed = urlparse(url)
        hostname = (parsed.hostname or "").lower().rstrip(".")
    except Exception:
        return True
    if parsed.scheme.lower() not in ("http", "https"):
        return False
    if not hostname:
        return True  # no verifiable host — do not fetch
    if hostname in _LOCAL_HOSTNAMES:
        return True
    if hostname.split(".")[-1] in _LOCAL_TLDS:
        return True
    try:
        ip = ipaddress.ip_address(hostname)
    except ValueError:
        return False  # public DNS name — allowed (checked again per redirect)
    return _ip_is_private(ip)


HostnameResolver = Callable[[str], Iterable[str]]


def _resolve_hostname(hostname: str) -> tuple[str, ...]:
    """Resolve all stream addresses for *hostname* using the system resolver."""
    return tuple({
        result[4][0]
        for result in socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
    })


def _validated_target_addresses(
    url: str,
    resolver: HostnameResolver,
) -> tuple[str, tuple[str, ...], str | None]:
    """Return ``(hostname, public_addresses, rejection)`` for one HTTP hop."""
    if is_private_or_local_target(url):
        return "", (), "private or local address"
    try:
        hostname = (urlparse(url).hostname or "").lower().rstrip(".")
    except Exception as exc:
        return "", (), f"invalid target ({exc})"
    try:
        literal = ipaddress.ip_address(hostname)
        return hostname, (str(literal),), None
    except ValueError:
        pass

    try:
        resolved = resolver(hostname)
        raw_addresses = [resolved] if isinstance(resolved, str) else list(resolved)
    except Exception as exc:
        return hostname, (), f"hostname resolution failed ({exc})"
    if not raw_addresses:
        return hostname, (), "hostname resolution returned no addresses"

    addresses: list[str] = []
    for address in raw_addresses:
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            return hostname, (), f"hostname resolution returned an invalid address ({address})"
        if _ip_is_private(ip):
            return hostname, (), f"hostname resolves to private or local address ({address})"
        normalized = str(ip)
        if normalized not in addresses:
            addresses.append(normalized)
    return hostname, tuple(addresses), None


def _request_target_rejection(
    url: str,
    resolver: HostnameResolver,
) -> str | None:
    """Return a reason not to fetch *url*, resolving DNS names fail-closed."""
    return _validated_target_addresses(url, resolver)[2]


def _hostname_key(hostname: str | bytes) -> str:
    """Canonicalize resolver host arguments for exact pin matching."""
    if isinstance(hostname, bytes):
        hostname = hostname.decode("ascii")
    return hostname.rstrip(".").encode("idna").decode("ascii").lower()


@contextmanager
def _pin_getaddrinfo(
    hostname: str,
    addresses: tuple[str, ...],
) -> Iterator[None]:
    """Temporarily make *hostname* resolve only to prevalidated addresses.

    The URL remains hostname-based, so HTTP Host and TLS SNI/certificate
    verification retain their normal semantics.  Only the socket connection's
    address selection is pinned.  This checker is deliberately single-threaded;
    the process-global resolver hook is restored even when the request fails.
    """
    original_getaddrinfo = socket.getaddrinfo
    target_key = _hostname_key(hostname)
    address_keys = {_hostname_key(address) for address in addresses}

    def pinned_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        try:
            host_key = _hostname_key(host)
        except (UnicodeError, AttributeError):
            raise socket.gaierror(socket.EAI_NONAME, "unexpected resolver target") from None
        if host_key in address_keys:
            # Some clients may already substitute the numeric target.
            return original_getaddrinfo(host, port, family, type, proto, flags)
        if host_key != target_key:
            # With environment proxies disabled, no other DNS name is expected.
            # Fail closed rather than permit an unvalidated lookup.
            raise socket.gaierror(socket.EAI_NONAME, "unvalidated resolver target")

        pinned_results = []
        for address in addresses:
            pinned_results.extend(
                original_getaddrinfo(
                    address, port, family, type, proto,
                    flags | getattr(socket, "AI_NUMERICHOST", 0),
                )
            )
        return pinned_results

    socket.getaddrinfo = pinned_getaddrinfo
    try:
        yield
    finally:
        socket.getaddrinfo = original_getaddrinfo


def github_style_anchor(heading_text: str) -> str:
    """Convert heading text to a GitHub-style anchor ID.

    Lowercase, strip punctuation (except hyphens), spaces→hyphens.
    """
    text = heading_text.strip().lower()
    # Remove everything that isn't alphanumeric, spaces, or hyphens
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"\s+", "-", text)
    return text


def extract_anchors(content: str) -> set[str]:
    """Extract all heading anchors from markdown *content*.

    Handles ATX headings and Setext headings (``Title`` / ``===`` or
    ``---``), ignores headings inside fenced code, and applies GitHub-style
    ``-1``/``-2`` suffixes to duplicate headings.  Generated IDs are stripped
    of leading/trailing hyphens (matching the lookup side in
    ``check_internal_ref``).
    """
    cleaned = strip_code_blocks(content)
    lines = cleaned.split("\n")
    heading_texts: list[str] = []
    for index, line in enumerate(lines):
        atx = _HEADING_RE.match(line)
        if atx:
            heading_texts.append(atx.group(2).strip())
            continue
        # Setext underline: a line of only ``=`` or ``-`` directly after a
        # paragraph (non-blank, non-heading, non-definition) line.
        if index == 0 or not _SETEXT_UNDERLINE_RE.match(line.strip()):
            continue
        prev = lines[index - 1]
        prev_text = prev.strip()
        if (
            not prev_text
            or prev.startswith(("    ", "\t"))  # indented code block
            or _HEADING_RE.match(prev)
            or _SETEXT_UNDERLINE_RE.match(prev_text)
            or _LINK_DEF_START_RE.match(prev)
        ):
            continue
        heading_texts.append(prev_text)
    anchors: set[str] = set()
    for text in heading_texts:
        base = github_style_anchor(text).strip("-")
        if not base:
            continue
        candidate = base
        suffix = 1
        while candidate in anchors:
            candidate = f"{base}-{suffix}"
            suffix += 1
        anchors.add(candidate)
    return anchors


# ---------------------------------------------------------------------------
# Reference checking
# ---------------------------------------------------------------------------


@dataclass
class BrokenRef:
    ref: str
    kind: str  # "internal" or "external"
    reason: str


@dataclass
class MarkdownReport:
    rel_path: str
    broken_refs: list[BrokenRef] = field(default_factory=list)
    mtime: float = 0.0  # seconds since epoch

    @property
    def broken_count(self) -> int:
        return len(self.broken_refs)


def check_internal_ref(
    ref: str,
    doc_path: Path,
    check_anchors: bool,
) -> BrokenRef | None:
    """Return a ``BrokenRef`` if *ref* is broken, else ``None``."""
    # A bare "#" is a top-of-page link — always valid.
    if ref == "#":
        return None

    # Separate anchor from path
    anchor: str | None = None
    path_part = ref
    anchor_match = _ANCHOR_RE.search(ref)
    if anchor_match:
        anchor = anchor_match.group(1)
        path_part = ref[: anchor_match.start()]

    # Resolve the path relative to the document's directory
    if path_part:
        target = (doc_path.parent / path_part).resolve()
        # If the target is a directory, try adding index.md / README.md.
        # If no index file is found, the directory itself is a valid target
        # (many markdown renderers link to directory listings).
        if target.is_dir():
            for index in ("index.md", "index.mdx", "README.md", "readme.md"):
                if (target / index).is_file():
                    target = target / index
                    break
            else:
                # Directory exists — treat as valid, no file-not-found error.
                # Anchor check against a directory is skipped (no content to scan).
                if anchor and check_anchors:
                    # Can't validate anchors against a directory; skip silently.
                    pass
                return None
        if not target.is_file():
            return BrokenRef(ref, "internal", "file not found")
    else:
        # Pure anchor — the target is the current document
        target = doc_path

    # Anchor validation
    if anchor and check_anchors:
        try:
            content = target.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return BrokenRef(ref, "internal", f"cannot read target file for anchor #{anchor}")

        anchors = extract_anchors(content)
        # GitHub also strips leading/trailing hyphens from the generated id
        normalized_anchor = anchor.strip().lower().strip("-")
        if normalized_anchor not in anchors:
            return BrokenRef(ref, "internal", f"anchor #{anchor} not found")

    return None


_MAX_REDIRECTS = 10
_USER_AGENT = "Mozilla/5.0 (compatible; markdown-drift-checker/1.0)"


def _classify_http_status(ref: str, status: int) -> BrokenRef:
    """Classify a final failure status code (preserves prior diagnostics)."""
    if status in (401, 403):
        return BrokenRef(ref, "uncertain", f"HTTP {status} (access denied; may be bot-blocking)")
    if status == 429:
        return BrokenRef(ref, "uncertain", "HTTP 429 (rate limited; likely transient)")
    if status >= 500:
        return BrokenRef(ref, "uncertain", f"HTTP {status} (server error; likely transient)")
    return BrokenRef(ref, "external", f"HTTP {status}")


def _close_response(response: object | None) -> None:
    """Close a streamed response without masking the scan result."""
    if response is None:
        return
    close = getattr(response, "close", None)
    if close is None:
        return
    try:
        close()
    except Exception:
        # Closing is cleanup; preserve the result or exception being handled.
        pass


def check_external_ref(
    ref: str,
    timeout: float,
    verbose: bool,
    *,
    resolver: HostnameResolver | None = None,
) -> BrokenRef | None:
    """Return a ``BrokenRef`` if *ref* is broken or uncertain, else ``None``.

    Redirects are followed manually.  Immediately before every HEAD/GET,
    including retries and redirect hops, the hostname is freshly resolved and
    every returned address is rejected if it is non-public.  The request is
    then pinned to exactly those validated addresses while retaining the URL's
    hostname for Host, TLS SNI, and certificate verification.  Resolution is
    injectable so tests remain network- and DNS-independent.

    Status code classification:
    - 404, 410: definitively broken (kind ``'external'``)
    - 403, 401: access denied — may be bot-blocking (kind ``'uncertain'``)
    - 5xx, 429: server/rate-limit error — likely transient (kind ``'uncertain'``)
    - other 4xx: treat as broken (kind ``'external'``)
    - redirect to private/local address: not fetched (kind ``'uncertain'``)
    """
    import requests

    resolve = resolver or _resolve_hostname
    current = normalize_reference(ref)
    method = "head"
    redirects = 0
    response = None
    session = requests.Session()
    session.trust_env = False  # a proxy would resolve/connect outside the pin
    try:
        while True:
            hostname, addresses, rejection = _validated_target_addresses(current, resolve)
            if rejection is not None:
                if redirects:
                    reason = f"redirects to {rejection} ({current}); not fetched"
                else:
                    reason = f"unsafe target: {rejection}; not fetched"
                return BrokenRef(ref, "uncertain", reason)

            with _pin_getaddrinfo(hostname, addresses):
                response = session.request(
                    method, current, timeout=timeout, allow_redirects=False,
                    stream=True, headers={"User-Agent": _USER_AGENT},
                )
            if 300 <= response.status_code < 400:
                location = response.headers.get("Location")
                if location:
                    if redirects >= _MAX_REDIRECTS:
                        return BrokenRef(ref, "external", "too many redirects")
                    _close_response(response)
                    response = None
                    current = urljoin(current, location)
                    if urlparse(current).scheme.lower() not in ("http", "https"):
                        return BrokenRef(
                            ref, "uncertain",
                            f"redirects to unsupported scheme ({current}); not fetched",
                        )
                    redirects += 1
                    continue
            if response.status_code >= 400 and method == "head":
                _close_response(response)
                response = None
                method = "get"  # some servers reject HEAD — retry once with GET
                continue
            status = response.status_code
            if status >= 400:
                return _classify_http_status(ref, status)
            if verbose:
                print(f"  [ok] {ref} (HTTP {status})", file=sys.stderr)
            return None
    except requests.ConnectionError:
        return BrokenRef(ref, "uncertain", "connection failed")
    except requests.Timeout:
        return BrokenRef(ref, "uncertain", "timeout")
    except Exception as exc:
        return BrokenRef(ref, "uncertain", f"error: {exc}")
    finally:
        _close_response(response)
        session.close()


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------


def find_markdown_files(
    directory: Path,
    global_patterns: list[str],
    context_patterns: list[tuple[str, list[str]]],
) -> list[tuple[Path, str, float]]:
    """Return list of (path, rel_path, mtime) for all markdown files found."""
    active_patterns = collect_active_ignore_patterns(directory, global_patterns, context_patterns)
    results: list[tuple[Path, str, float]] = []

    for current, dir_names, file_names in os.walk(directory):
        current_path = Path(current)
        kept_dirs: list[str] = []
        for name in dir_names:
            child = current_path / name
            rel_dir = child.relative_to(directory).as_posix()
            if any(fnmatch.fnmatch(name, pattern) for pattern in SKIP_DIRS):
                continue
            if matches_ignore_patterns(f"{rel_dir}/_", active_patterns):
                continue
            kept_dirs.append(name)
        dir_names[:] = kept_dirs

        for name in file_names:
            file = current_path / name
            if file.suffix.lower() not in MARKDOWN_EXTENSIONS:
                continue
            rel_path = file.relative_to(directory).as_posix()
            if matches_ignore_patterns(rel_path, active_patterns):
                continue

            mtime = file.stat().st_mtime
            results.append((file, rel_path, mtime))

    return results


@dataclass
class UrlBudget:
    """Scan-wide budget for external URL checks.

    ``max_urls`` limits the number of external URLs checked across every
    document in the scan (not per document); ``0`` disables the limit.
    ``used`` accumulates the number of URLs actually checked.
    """

    max_urls: int
    used: int = 0

    def try_consume(self) -> bool:
        """Reserve one URL check; return False when the budget is exhausted."""
        if self.max_urls <= 0 or self.used < self.max_urls:
            self.used += 1
            return True
        return False


def check_document(
    file: Path,
    rel_path: str,
    mtime: float,
    *,
    check_anchors: bool,
    skip_external: bool,
    timeout: float,
    url_budget: UrlBudget,
    verbose: bool,
) -> tuple[MarkdownReport, int]:
    """Check a single markdown document for broken references.

    The external-URL budget *url_budget* is shared across the whole scan:
    documents processed after it is exhausted report their remaining URLs as
    ``skipped``.  Returns ``(report, external_urls_checked)``.
    """
    report = MarkdownReport(rel_path=rel_path, mtime=mtime)

    try:
        content = file.read_text(encoding="utf-8", errors="ignore")
    except OSError as exc:
        report.broken_refs.append(BrokenRef("(read error)", "internal", str(exc)))
        return report, 0

    refs = extract_references(content)
    external_checked = 0

    for ref in refs:
        kind = classify_reference(ref, check_anchors=check_anchors)
        if kind == "skip":
            continue

        if kind in ("internal", "anchor"):
            # For same-document anchors, pass an empty path part so the
            # resolver treats it as the current document.
            broken = check_internal_ref(ref, file, check_anchors)
            if broken is not None:
                report.broken_refs.append(broken)
            elif verbose:
                print(f"  [ok] {ref}", file=sys.stderr)

        elif kind == "external":
            if skip_external:
                continue
            if not url_budget.try_consume():
                report.broken_refs.append(BrokenRef(ref, "skipped", "not checked (max-urls limit reached)"))
                continue

            broken = check_external_ref(ref, timeout, verbose)
            external_checked += 1
            if broken is not None:
                report.broken_refs.append(broken)

    return report, external_checked


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Find markdown files and check for document drift (stale references).",
    )
    parser.add_argument("directory", type=str, help="Root directory to scan")
    parser.add_argument(
        "--timeout", type=float, default=10,
        help="HTTP request timeout per URL in seconds (default: 10)",
    )
    parser.add_argument(
        "--max-urls", type=_non_negative_int, default=200,
        help="Maximum external URLs to check across the whole scan; "
             "0 = unlimited (default: 200)",
    )
    parser.add_argument(
        "--skip-external", action="store_true",
        help="Skip all external URL checks (only check internal references)",
    )
    parser.add_argument(
        "--check-anchors", action="store_true",
        help="Validate #anchor fragments against heading IDs in target files",
    )
    parser.add_argument(
        "-v", "--verbose", action="store_true",
        help="Print each reference as it is checked",
    )
    return parser.parse_args(argv)


def _non_negative_int(value: str) -> int:
    """argparse type: reject negative values (used for ``--max-urls``)."""
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"invalid integer value: {value!r}") from None
    if number < 0:
        raise argparse.ArgumentTypeError("--max-urls must be nonnegative (0 = unlimited)")
    return number


def main() -> None:
    # Ensure stdout can handle Unicode on Windows consoles (cp1252)
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    if hasattr(sys.stderr, "reconfigure"):
        try:
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    args = parse_args()
    directory = Path(args.directory).resolve()
    if not directory.is_dir():
        print(f"error: not a directory: {args.directory}", file=sys.stderr)
        sys.exit(1)

    script_dir = Path(__file__).parent.resolve()
    global_patterns, context_patterns = load_ignore_patterns(script_dir)

    md_files = find_markdown_files(directory, global_patterns, context_patterns)
    if not md_files:
        print("no markdown files found")
        return

    # Sort by mtime (oldest first — most stale surfaces at top)
    md_files.sort(key=lambda t: t[2])

    reports: list[MarkdownReport] = []
    total_external_checked = 0
    url_budget = UrlBudget(max_urls=args.max_urls)  # shared across the scan

    for file, rel_path, mtime in md_files:
        report, ext_checked = check_document(
            file, rel_path, mtime,
            check_anchors=args.check_anchors,
            skip_external=args.skip_external,
            timeout=args.timeout,
            url_budget=url_budget,
            verbose=args.verbose,
        )
        reports.append(report)
        total_external_checked += ext_checked

    # --- Summary (sorted by last-modified, oldest first) ---
    print("=== Markdown document drift ===")

    max_path_len = max(len(r.rel_path) for r in reports)
    for report in reports:
        mod_date = datetime.fromtimestamp(report.mtime, tz=timezone.utc).strftime("%Y-%m-%d")
        # Split counts: "skipped" items are informational, not problems
        definite = sum(1 for br in report.broken_refs if br.kind not in ("uncertain", "skipped"))
        uncertain = sum(1 for br in report.broken_refs if br.kind == "uncertain")
        skipped = sum(1 for br in report.broken_refs if br.kind == "skipped")
        parts: list[str] = []
        if definite:
            label = "broken ref" if definite == 1 else "broken refs"
            parts.append(f"{definite} {label}")
        if uncertain:
            label = "uncertain" if uncertain == 1 else "uncertain"
            parts.append(f"{uncertain} {label}")
        if skipped:
            parts.append(f"{skipped} skipped")
        status = ", ".join(parts) if parts else "ok"
        print(
            f"  {report.rel_path:<{max_path_len}}  "
            f"{status}  "
            f"modified {mod_date}"
        )

    total_definite = sum(
        sum(1 for br in r.broken_refs if br.kind not in ("uncertain", "skipped"))
        for r in reports
    )
    total_uncertain = sum(
        sum(1 for br in r.broken_refs if br.kind == "uncertain")
        for r in reports
    )
    total_docs = len(reports)
    docs_with_broken = sum(1 for r in reports if r.broken_count > 0)
    print()
    print(
        f"Total: {total_docs} docs, {docs_with_broken} with issues, "
        f"{total_definite} broken, {total_uncertain} uncertain"
    )
    if not args.skip_external:
        print(f"External URLs checked: {total_external_checked}")

    # --- Detail section ---
    docs_with_detail = [r for r in reports if r.broken_count > 0]
    if docs_with_detail:
        print()
        print("--- Broken references ---")
        for report in docs_with_detail:
            print(report.rel_path)
            for br in report.broken_refs:
                print(f"  [{br.kind}] {br.ref} ({br.reason})")


if __name__ == "__main__":
    main()