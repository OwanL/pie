#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Focused regression tests for ``find_markdown_drift.py``.

Stdlib-only (``unittest``).  Run directly or via discovery:

    python skills/codebase-maintenance/test_find_markdown_drift.py
    python -m unittest discover -s skills/codebase-maintenance -p "test_*.py"

Network-free: external fetch tests inject a fake ``requests`` module and
assert that private/local targets (including redirect destinations) are
never actually requested.
"""

from __future__ import annotations

import contextlib
import importlib.util
import http.client
import io
import socket
import sys
import tempfile
import threading
import types
import unittest
import unittest.mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

_HERE = Path(__file__).resolve().parent
_SPEC = importlib.util.spec_from_file_location(
    "find_markdown_drift", _HERE / "find_markdown_drift.py"
)
if _SPEC is None or _SPEC.loader is None:  # pragma: no cover
    raise RuntimeError("could not load find_markdown_drift.py")
_find_markdown_drift = importlib.util.module_from_spec(_SPEC)
sys.modules.setdefault("find_markdown_drift", _find_markdown_drift)
_SPEC.loader.exec_module(_find_markdown_drift)

fmd = _find_markdown_drift


# ---------------------------------------------------------------------------
# Fake `requests` plumbing
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(
        self,
        status_code: int = 200,
        headers: dict[str, str] | None = None,
        close_calls: list[object] | None = None,
    ):
        self.status_code = status_code
        self.headers = headers if headers is not None else {}
        self._close_calls = close_calls

    def close(self):
        if self._close_calls is not None:
            self._close_calls.append(self)


def _public_resolver(_hostname: str) -> list[str]:
    """Deterministic DNS stub returning a globally routable documentation IP."""
    return ["93.184.216.34"]


def _make_fake_requests(handler, log: list[tuple[str, str]]):
    """Build a fake ``requests`` module; *handler(method, url)* -> _FakeResponse.

    Returning ``None`` from the handler means "unexpected fetch" and fails the
    test, proving the target was never requested.
    """
    fake = types.ModuleType("requests")

    class ConnectionError(Exception):
        pass

    class Timeout(Exception):
        pass

    fake.ConnectionError = ConnectionError
    fake.Timeout = Timeout

    def _request(method, url, timeout=None, allow_redirects=True, stream=False, headers=None):
        log.append((method, url))
        response = handler(method, url)
        if response is None:
            raise AssertionError(f"unexpected request: {method} {url}")
        return response

    class Session:
        trust_env = True

        def request(self, *args, **kwargs):
            return _request(*args, **kwargs)

        def close(self):
            pass

    fake.Session = Session
    return fake


# ---------------------------------------------------------------------------
# Reference extraction
# ---------------------------------------------------------------------------


class NativeIgnoreTests(unittest.TestCase):
    def test_egg_info_directories_are_not_scanned(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            ignored = root / "package.egg-info"
            ignored.mkdir()
            (ignored / "README.md").write_text("[bad](missing.md)", encoding="utf-8")
            (root / "README.md").write_text("# Kept", encoding="utf-8")
            found = fmd.find_markdown_files(root, [], [])
        self.assertEqual([rel for _path, rel, _mtime in found], ["README.md"])


class ProtocolRelativeTests(unittest.TestCase):
    def test_normalize_reference(self):
        self.assertEqual(fmd.normalize_reference("//example.com/x"), "https://example.com/x")
        self.assertEqual(fmd.normalize_reference("https://example.com"), "https://example.com")

    def test_extract_references_normalizes_protocol_relative(self):
        content = "[docs](//example.com/page) ![img](//cdn.example.org/a.png)"
        self.assertEqual(
            fmd.extract_references(content),
            ["https://example.com/page", "https://cdn.example.org/a.png"],
        )


class ReferenceLinkTests(unittest.TestCase):
    def test_inline_link_single_quoted_title(self):
        content = "See [guide](https://docs.example/guide 'the guide') now."
        self.assertEqual(fmd.extract_references(content), ["https://docs.example/guide"])

    def test_inline_link_double_quoted_title_still_works(self):
        content = 'See [guide](https://docs.example/guide "the guide") now.'
        self.assertEqual(fmd.extract_references(content), ["https://docs.example/guide"])

    def test_reference_links_full_collapsed_shortcut(self):
        content = "\n".join([
            "Full [one][alpha] and collapsed [two][] and shortcut [three].",
            "",
            "[alpha]: https://alpha.example/full",
            "[TWO]: https://two.example/collapsed",
            "[three]: https://three.example/shortcut",
            "[unused]: https://unused.example/x",
        ])
        self.assertEqual(
            fmd.extract_references(content),
            [
                "https://alpha.example/full",
                "https://two.example/collapsed",
                "https://three.example/shortcut",
                "https://unused.example/x",
            ],
        )

    def test_reference_link_label_normalization(self):
        content = "\n".join([
            "See [My  Link][my-link].",
            "",
            "[MY-LINK]: https://x.example/a",
        ])
        self.assertEqual(fmd.extract_references(content), ["https://x.example/a"])

    def test_reference_link_unknown_label_ignored(self):
        content = "See [one][missing] — no definition exists."
        self.assertEqual(fmd.extract_references(content), [])

    def test_extract_references_dedupes_repeated_urls(self):
        content = "[a](https://x.example/1) [b](https://x.example/1) [c][ref]\n\n[ref]: https://x.example/1"
        self.assertEqual(fmd.extract_references(content), ["https://x.example/1"])

    def test_inline_link_text_not_treated_as_shortcut_reference(self):
        # The link text of an inline link must not be resolved as a label.
        content = "[docs](https://docs.example/guide)"
        self.assertEqual(fmd.extract_references(content), ["https://docs.example/guide"])

    def test_inline_destination_preserves_balanced_parentheses(self):
        content = "See [API](https://docs.example/api(v2)/call(arg)) now."
        self.assertEqual(
            fmd.extract_references(content),
            ["https://docs.example/api(v2)/call(arg)"],
        )

    def test_duplicate_reference_definition_first_wins(self):
        content = "[guide][]\n\n[guide]: first(page).md\n[GUIDE]: second.md"
        self.assertEqual(fmd.extract_references(content), ["first(page).md"])


class FencedCodeTests(unittest.TestCase):
    def test_links_inside_fenced_code_ignored(self):
        content = "\n".join([
            "# Title",
            "",
            "```bash",
            "curl [not-a-link](https://in-code.example/a)",
            "```",
            "",
            "~~~python",
            "x = [also-not](https://in-code.example/b)",
            "~~~",
            "",
            "[real](https://real.example/page)",
        ])
        self.assertEqual(fmd.extract_references(content), ["https://real.example/page"])

    def test_fenced_code_crlf(self):
        content = "```js\r\n[a](https://in.example/a)\r\n```\r\n[b](https://out.example/b)\r\n"
        self.assertEqual(fmd.extract_references(content), ["https://out.example/b"])

    def test_fenced_code_commonmark_variants(self):
        # CommonMark: a closing fence must use the same character and be at
        # least as long as the opening fence (a longer run closes); opposite-
        # character runs never close; fences can be indented up to 3 spaces.
        content = "\n".join([
            "   ```py",                      # opening fence, indented 3 spaces, info string
            "[x](https://in1.example/x)",
            "  ~~~",                         # tilde run does NOT close a backtick fence
            "[y](https://in2.example/y)",    # still inside the backtick fence
            "  ````",                        # longer backtick run closes it
            "[z](https://out.example/z)",
        ])
        self.assertEqual(fmd.extract_references(content), ["https://out.example/z"])

    def test_inline_code_span_link_ignored(self):
        content = "Use `[skip](https://in.example/i)` in prose but [keep](https://out.example/o)."
        self.assertEqual(fmd.extract_references(content), ["https://out.example/o"])

    def test_reference_definitions_inside_fences_ignored(self):
        content = "\n".join([
            "```",
            "[fake]: https://in.example/def",
            "```",
            "[real]: https://out.example/def",
        ])
        self.assertEqual(fmd.extract_references(content), ["https://out.example/def"])


# ---------------------------------------------------------------------------
# Anchors (ATX + Setext + duplicate suffixes)
# ---------------------------------------------------------------------------


class AnchorTests(unittest.TestCase):
    def test_extract_anchors_setext_and_duplicate_suffixes(self):
        content = "\n".join([
            "Install Guide",
            "=============",
            "",
            "## Setup",
            "",
            "### Setup",
            "",
            "## Usage",
            "",
            "Setup",
            "-----",
        ])
        self.assertEqual(
            fmd.extract_anchors(content),
            {"install-guide", "setup", "setup-1", "usage", "setup-2"},
        )

    def test_extract_anchors_ignores_headings_in_code_fences(self):
        content = "```sh\n# not a heading\n```\n\n# Real\n"
        self.assertEqual(fmd.extract_anchors(content), {"real"})

    def test_thematic_break_not_treated_as_setext(self):
        content = "\n".join([
            "Paragraph one.",
            "",
            "---",
            "",
            "# After",
        ])
        self.assertEqual(fmd.extract_anchors(content), {"after"})

    def _write_doc(self, tmp: Path, text: str) -> Path:
        doc = tmp / "doc.md"
        doc.write_text(text, encoding="utf-8")
        return doc

    def test_check_internal_ref_setext_anchor(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            doc = self._write_doc(Path(tmpdir), "Quick Start\n===========\n")
            self.assertIsNone(fmd.check_internal_ref("doc.md#quick-start", doc, True))

    def test_check_internal_ref_duplicate_heading_suffixes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            doc = self._write_doc(Path(tmpdir), "## Setup\n\n## Setup\n")
            self.assertIsNone(fmd.check_internal_ref("doc.md#setup", doc, True))
            self.assertIsNone(fmd.check_internal_ref("doc.md#setup-1", doc, True))
            broken = fmd.check_internal_ref("doc.md#setup-2", doc, True)
            self.assertIsNotNone(broken)
            assert broken is not None
            self.assertIn("anchor", broken.reason)


# ---------------------------------------------------------------------------
# --max-urls validation and scan-wide budget
# ---------------------------------------------------------------------------


class BudgetTests(unittest.TestCase):
    def test_url_budget_try_consume(self):
        budget = fmd.UrlBudget(max_urls=2)
        self.assertTrue(budget.try_consume())
        self.assertTrue(budget.try_consume())
        self.assertFalse(budget.try_consume())
        self.assertEqual(budget.used, 2)

    def test_url_budget_zero_is_unlimited(self):
        budget = fmd.UrlBudget(max_urls=0)
        for _ in range(50):
            self.assertTrue(budget.try_consume())
        self.assertEqual(budget.used, 50)

    def test_parse_args_rejects_negative_max_urls(self):
        stderr = io.StringIO()
        with self.assertRaises(SystemExit) as ctx, contextlib.redirect_stderr(stderr):
            fmd.parse_args(["somedir", "--max-urls", "-1"])
        self.assertEqual(ctx.exception.code, 2)
        self.assertIn("nonnegative", stderr.getvalue())

    def test_parse_args_accepts_zero_max_urls(self):
        args = fmd.parse_args(["somedir", "--max-urls", "0"])
        self.assertEqual(args.max_urls, 0)

    def test_url_budget_is_scan_wide_across_documents(self):
        log: list[tuple[str, str]] = []

        def fake_check(ref, timeout, verbose):
            log.append(("external", ref))
            return None

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "a.md").write_text(
                "[a](https://a.example/1) [b](https://a.example/2)", encoding="utf-8",
            )
            (root / "b.md").write_text("[c](https://b.example/1)", encoding="utf-8")
            budget = fmd.UrlBudget(max_urls=2)
            with unittest.mock.patch.object(fmd, "check_external_ref", fake_check):
                report_a, count_a = fmd.check_document(
                    root / "a.md", "a.md", 1.0,
                    check_anchors=False, skip_external=False, timeout=1,
                    url_budget=budget, verbose=False,
                )
                report_b, count_b = fmd.check_document(
                    root / "b.md", "b.md", 2.0,
                    check_anchors=False, skip_external=False, timeout=1,
                    url_budget=budget, verbose=False,
                )
            self.assertEqual(count_a, 2)
            self.assertEqual(count_b, 0)
            self.assertEqual(log, [("external", "https://a.example/1"), ("external", "https://a.example/2")])
            skipped = [br for br in report_b.broken_refs if br.kind == "skipped"]
            self.assertEqual([br.ref for br in skipped], ["https://b.example/1"])
            self.assertEqual(budget.used, 2)


# ---------------------------------------------------------------------------
# Private/local target protection (incl. redirects)
# ---------------------------------------------------------------------------


class DnsPinIntegrationTests(unittest.TestCase):
    def test_local_rebind_probe_uses_validated_address_and_restores_resolver(self):
        received_hosts: list[str] = []

        class Handler(BaseHTTPRequestHandler):
            def do_HEAD(self):
                received_hosts.append(self.headers.get("Host", ""))
                self.send_response(200)
                self.end_headers()

            def log_message(self, _format, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        original_getaddrinfo = socket.getaddrinfo
        rebound_lookups: list[str] = []

        def rebinding_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
            if fmd._hostname_key(host) == "rebind.invalid":
                rebound_lookups.append(str(host))
                return original_getaddrinfo("127.0.0.2", port, family, type, proto, flags)
            return original_getaddrinfo(host, port, family, type, proto, flags)

        transport = types.ModuleType("requests")

        class ConnectionError(Exception):
            pass

        class Timeout(Exception):
            pass

        class Response:
            def __init__(self, connection, raw_response):
                self._connection = connection
                self._raw_response = raw_response
                self.status_code = raw_response.status
                self.headers = dict(raw_response.getheaders())

            def close(self):
                self._raw_response.close()
                self._connection.close()

        class Session:
            trust_env = True

            def request(self, method, url, timeout=None, headers=None, **_kwargs):
                parsed = urlparse(url)
                connection = http.client.HTTPConnection(
                    parsed.hostname, parsed.port, timeout=timeout,
                )
                try:
                    path = parsed.path or "/"
                    if parsed.query:
                        path += f"?{parsed.query}"
                    connection.request(method.upper(), path, headers=headers or {})
                    return Response(connection, connection.getresponse())
                except socket.timeout as exc:
                    connection.close()
                    raise Timeout from exc
                except OSError as exc:
                    connection.close()
                    raise ConnectionError from exc

            def close(self):
                pass

        transport.ConnectionError = ConnectionError
        transport.Timeout = Timeout
        transport.Session = Session

        try:
            with unittest.mock.patch.dict(sys.modules, {"requests": transport}), \
                    unittest.mock.patch.object(socket, "getaddrinfo", new=rebinding_getaddrinfo), \
                    unittest.mock.patch.object(fmd, "_ip_is_private", return_value=False):
                broken = fmd.check_external_ref(
                    f"http://rebind.invalid:{server.server_port}/probe",
                    timeout=2,
                    verbose=False,
                    resolver=lambda _hostname: ["127.0.0.1"],
                )
                self.assertIs(socket.getaddrinfo, rebinding_getaddrinfo)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertIsNone(broken)
        self.assertEqual(rebound_lookups, [])
        self.assertEqual(received_hosts, [f"rebind.invalid:{server.server_port}"])


class PrivateTargetTests(unittest.TestCase):
    def test_classify_reference_skips_private_targets(self):
        private_urls = [
            "http://localhost:3000/x",
            "http://127.0.0.1",
            "http://127.0.0.1:8080/admin",
            "http://10.1.2.3/x",
            "http://172.16.0.1/x",
            "http://172.31.255.254/x",
            "http://192.168.0.15/x",
            "http://169.254.1.1/x",
            "http://100.64.0.1/x",       # shared/CGNAT, not globally routable
            "http://198.18.0.1/x",       # benchmark range
            "http://0.0.0.0/x",
            "http://[::1]:9000/x",
            "http://[::ffff:127.0.0.1]/x",
            "http://[fe80::1]/x",
            "http://[fd00::1]/x",
            "https://myhost.local/x",
            "https://db.internal:5432/x",
        ]
        for url in private_urls:
            with self.subTest(url=url):
                self.assertEqual(fmd.classify_reference(url), "skip")

    def test_classify_reference_public_targets(self):
        public_urls = [
            "https://example.com",
            "https://172.32.0.1/x",
            "https://sub.example.com/page?q=1",
        ]
        for url in public_urls:
            with self.subTest(url=url):
                self.assertEqual(fmd.classify_reference(url), "external")

    def test_check_external_ref_never_fetches_private_target(self):
        log: list[tuple[str, str]] = []
        handler = lambda method, url: None  # any fetch is unexpected
        fake = _make_fake_requests(handler, log)
        with unittest.mock.patch.dict(sys.modules, {"requests": fake}):
            broken = fmd.check_external_ref("http://127.0.0.1:8080/secret", timeout=1, verbose=False)
        self.assertIsNotNone(broken)
        assert broken is not None
        self.assertEqual(broken.kind, "uncertain")
        self.assertIn("private or local", broken.reason)
        self.assertEqual(log, [])

    def test_check_external_ref_blocks_hostname_resolving_private(self):
        log: list[tuple[str, str]] = []
        fake = _make_fake_requests(lambda method, url: None, log)
        with unittest.mock.patch.dict(sys.modules, {"requests": fake}):
            broken = fmd.check_external_ref(
                "https://public-name.example/secret", timeout=1, verbose=False,
                resolver=lambda hostname: ["93.184.216.34", "10.0.0.8"],
            )
        self.assertIsNotNone(broken)
        assert broken is not None
        self.assertIn("resolves to private or local", broken.reason)
        self.assertEqual(log, [])

    def test_check_external_ref_fails_closed_when_dns_fails(self):
        log: list[tuple[str, str]] = []
        fake = _make_fake_requests(lambda method, url: None, log)

        def failing_resolver(_hostname):
            raise OSError("DNS unavailable")

        with unittest.mock.patch.dict(sys.modules, {"requests": fake}):
            broken = fmd.check_external_ref(
                "https://public-name.example/secret", timeout=1, verbose=False,
                resolver=failing_resolver,
            )
        self.assertIsNotNone(broken)
        assert broken is not None
        self.assertIn("resolution failed", broken.reason)
        self.assertEqual(log, [])

    def test_check_external_ref_blocks_private_redirect(self):
        log: list[tuple[str, str]] = []

        def handler(method, url):
            if url == "https://public.example/start":
                return _FakeResponse(301, {"Location": "http://192.168.1.10/secret"})
            return None

        fake = _make_fake_requests(handler, log)
        with unittest.mock.patch.dict(sys.modules, {"requests": fake}):
            broken = fmd.check_external_ref(
                "https://public.example/start", timeout=1, verbose=False,
                resolver=_public_resolver,
            )
        self.assertIsNotNone(broken)
        assert broken is not None
        self.assertEqual(broken.kind, "uncertain")
        self.assertIn("redirects to private or local address", broken.reason)
        # Only the initial public hop may be requested — never the private one.
        self.assertEqual(log, [("head", "https://public.example/start")])

    def test_check_external_ref_blocks_redirect_hostname_resolving_private(self):
        log: list[tuple[str, str]] = []

        def handler(method, url):
            if url == "https://public.example/start":
                return _FakeResponse(302, {"Location": "https://redirect.example/secret"})
            return None

        def resolver(hostname):
            if hostname == "redirect.example":
                return ["169.254.10.20"]
            return _public_resolver(hostname)

        fake = _make_fake_requests(handler, log)
        with unittest.mock.patch.dict(sys.modules, {"requests": fake}):
            broken = fmd.check_external_ref(
                "https://public.example/start", timeout=1, verbose=False,
                resolver=resolver,
            )
        self.assertIsNotNone(broken)
        assert broken is not None
        self.assertIn("redirects to hostname resolves to private or local", broken.reason)
        self.assertEqual(log, [("head", "https://public.example/start")])

    def test_check_external_ref_follows_public_redirect_chain(self):
        log: list[tuple[str, str]] = []
        resolved: list[str] = []

        def resolver(hostname):
            resolved.append(hostname)
            return _public_resolver(hostname)

        def handler(method, url):
            if url == "https://a.example/start":
                return _FakeResponse(302, {"Location": "/next"})
            if url == "https://a.example/next":
                return _FakeResponse(301, {"Location": "https://final.example/done"})
            if url == "https://final.example/done":
                return _FakeResponse(200)
            return None

        fake = _make_fake_requests(handler, log)
        with unittest.mock.patch.dict(sys.modules, {"requests": fake}):
            broken = fmd.check_external_ref(
                "https://a.example/start", timeout=1, verbose=False,
                resolver=resolver,
            )
        self.assertIsNone(broken)
        self.assertEqual(
            log,
            [
                ("head", "https://a.example/start"),
                ("head", "https://a.example/next"),
                ("head", "https://final.example/done"),
            ],
        )
        self.assertEqual(resolved, ["a.example", "a.example", "final.example"])

    def test_check_external_ref_redirect_loop_reports_too_many_redirects(self):
        log: list[tuple[str, str]] = []

        def handler(method, url):
            if url == "https://loop.example/round":
                return _FakeResponse(302, {"Location": "/round"})
            return None

        fake = _make_fake_requests(handler, log)
        with unittest.mock.patch.dict(sys.modules, {"requests": fake}):
            broken = fmd.check_external_ref(
                "https://loop.example/round", timeout=1, verbose=False,
                resolver=_public_resolver,
            )
        self.assertIsNotNone(broken)
        assert broken is not None
        self.assertEqual(broken.kind, "external")
        self.assertEqual(broken.reason, "too many redirects")

    def test_check_external_ref_closes_response_on_redirect_limit(self):
        log: list[tuple[str, str]] = []
        close_calls: list[object] = []
        responses: list[_FakeResponse] = []

        def handler(method, url):
            response = _FakeResponse(302, {"Location": "/round"}, close_calls)
            responses.append(response)
            return response

        fake = _make_fake_requests(handler, log)
        with unittest.mock.patch.dict(sys.modules, {"requests": fake}):
            broken = fmd.check_external_ref(
                "https://loop.example/round", timeout=1, verbose=False,
                resolver=_public_resolver,
            )

        self.assertIsNotNone(broken)
        assert broken is not None
        self.assertEqual(broken.reason, "too many redirects")
        self.assertEqual(len(responses), fmd._MAX_REDIRECTS + 1)
        self.assertEqual(close_calls, responses)

    def test_check_external_ref_redirect_to_unsupported_scheme(self):
        log: list[tuple[str, str]] = []

        def handler(method, url):
            if url == "https://a.example/start":
                return _FakeResponse(302, {"Location": "ftp://files.example/x"})
            return None

        fake = _make_fake_requests(handler, log)
        with unittest.mock.patch.dict(sys.modules, {"requests": fake}):
            broken = fmd.check_external_ref(
                "https://a.example/start", timeout=1, verbose=False,
                resolver=_public_resolver,
            )
        self.assertIsNotNone(broken)
        assert broken is not None
        self.assertEqual(broken.kind, "uncertain")
        self.assertIn("unsupported scheme", broken.reason)
        self.assertEqual(log, [("head", "https://a.example/start")])

    def test_check_external_ref_head_then_get_retry(self):
        log: list[tuple[str, str]] = []
        resolved: list[str] = []

        def resolver(hostname):
            resolved.append(hostname)
            return _public_resolver(hostname)

        def handler(method, url):
            if url == "https://x.example/a":
                return _FakeResponse(405) if method == "head" else _FakeResponse(200)
            return None

        fake = _make_fake_requests(handler, log)
        with unittest.mock.patch.dict(sys.modules, {"requests": fake}):
            broken = fmd.check_external_ref(
                "https://x.example/a", timeout=1, verbose=False,
                resolver=resolver,
            )
        self.assertIsNone(broken)
        self.assertEqual(log, [("head", "https://x.example/a"), ("get", "https://x.example/a")])
        self.assertEqual(resolved, ["x.example", "x.example"])

    def test_check_external_ref_broken_status_classification(self):
        cases = [
            (404, "external", "HTTP 404"),
            (410, "external", "HTTP 410"),
            (403, "uncertain", "access denied"),
            (429, "uncertain", "rate limited"),
            (503, "uncertain", "server error"),
        ]
        for status, kind, expected_fragment in cases:
            with self.subTest(status=status):
                log: list[tuple[str, str]] = []

                def handler(method, url, status=status):
                    return _FakeResponse(status)

                fake = _make_fake_requests(handler, log)
                with unittest.mock.patch.dict(sys.modules, {"requests": fake}):
                    broken = fmd.check_external_ref(
                        "https://x.example/bad", timeout=1, verbose=False,
                        resolver=_public_resolver,
                    )
                self.assertIsNotNone(broken)
                assert broken is not None
                self.assertEqual(broken.kind, kind)
                self.assertIn(expected_fragment, broken.reason)


if __name__ == "__main__":
    unittest.main(verbosity=2)