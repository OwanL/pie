"""Tests for the account-pause circuit breaker (proxy/pie_proxy_runtime.py).

Covers:
- `_extract_pause_until` parsing the real umans suspended-account message.
- Non-suspension bodies return None (no false pause).
- `AccountPauseCircuitBreaker` short-circuits proxied LLM requests while paused
  (429 + Retry-After, NO downstream call) and leaves health/models endpoints alone.
- The breaker learns the pause from a 429 response body and arms the short-circuit.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pie_proxy_runtime import (  # noqa: E402
    AccountPauseCircuitBreaker,
    _ACCOUNT_PAUSED_UNTIL,
    _extract_pause_until,
    _account_paused_now,
    _set_account_pause,
    install_account_pause_circuit_breaker,
    _is_proxied_llm_path,
)

# Reactivation time used in the fixture bodies below. Computed relative to
# "now" so the learn-pause test (asserts remaining > 1000s) never goes stale as
# a pinned date drifts into the past. Truncated to the minute (zero seconds)
# because the stamp format ("%Y-%m-%d %H:%M UTC") discards seconds, and the
# extractor tests assert against _REACTIVATION_DT.timestamp() to second precision.
_REACTIVATION_DT = (datetime.now(timezone.utc) + timedelta(hours=6)).replace(second=0, microsecond=0)
_REACTIVATION_STAMP = _REACTIVATION_DT.strftime("%Y-%m-%d %H:%M UTC").encode()

REAL_BODY = (
    b'{"error":{"message":"litellm.RateLimitError: RateLimitError: '
    b'OpenAIException - Your access is paused for repeatedly exceeding rate limits. '
    b'It reactivates automatically at ' + _REACTIVATION_STAMP + b' \xe2\x80\x94 no action needed. '
    b'To resume sooner, reactivate from your dashboard",'
    b'"type":"upstream_account_paused"}}'
)

# The upstream 403 body (openai.PermissionDeniedError) carries account_suspended.
UPSTREAM_BODY = (
    b"openai.PermissionDeniedError: Error code: 403 - "
    b"{'type': 'billing_error', 'error': {'type': 'account_suspended', "
    b"'message': 'Your access is paused for repeatedly exceeding rate limits. "
    b"It reactivates automatically at " + _REACTIVATION_STAMP + b".' "
    b"'reason': 'cap_abuse', 'self_reactivations_remaining': 7}}"
)


class TestExtractPauseUntil(unittest.IsolatedAsyncioTestCase):
    def test_parses_real_litellm_wrapped_body(self):
        result = _extract_pause_until(REAL_BODY)
        self.assertIsNotNone(result)
        until, msg = result  # type: ignore[misc]
        self.assertAlmostEqual(until, _REACTIVATION_DT.timestamp(), places=0)
        self.assertIn("paused", msg)

    def test_parses_upstream_403_body(self):
        result = _extract_pause_until(UPSTREAM_BODY)
        self.assertIsNotNone(result)
        until, _ = result  # type: ignore[misc]
        self.assertAlmostEqual(until, _REACTIVATION_DT.timestamp(), places=0)

    def test_non_suspension_body_returns_none(self):
        self.assertIsNone(_extract_pause_until(b'{"error":"rate limited briefly"}'))
        self.assertIsNone(_extract_pause_until(b""))
        self.assertIsNone(_extract_pause_until(b'{"ok":true}'))

    def test_suspension_without_parseable_time_returns_none(self):
        # Signature present but no reactivation time -> None from extractor.
        # (The middleware falls back to a bounded cooldown in this case.)
        self.assertIsNone(_extract_pause_until(b"account_suspended but no time given"))


class TestPauseState(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        # Reset global pause state between tests.
        import pie_proxy_runtime as rt
        rt._ACCOUNT_PAUSED_UNTIL = 0.0
        rt._ACCOUNT_PAUSE_MESSAGE = ""

    async def test_set_and_read_pause(self):
        until = (datetime.now(timezone.utc) + timedelta(seconds=120)).timestamp()
        await _set_account_pause(until, "test pause")
        remaining = _account_paused_now()
        self.assertGreater(remaining, 118)
        self.assertLessEqual(remaining, 120)

    async def test_expired_pause_clears(self):
        until = (datetime.now(timezone.utc) - timedelta(seconds=10)).timestamp()
        import pie_proxy_runtime as rt
        rt._ACCOUNT_PAUSED_UNTIL = until
        rt._ACCOUNT_PAUSE_MESSAGE = "stale"
        self.assertEqual(_account_paused_now(), 0.0)
        # State cleared so a subsequent read doesn't recompute.
        self.assertEqual(rt._ACCOUNT_PAUSED_UNTIL, 0.0)

    async def test_keeps_longer_pause(self):
        far = (datetime.now(timezone.utc) + timedelta(seconds=600)).timestamp()
        near = (datetime.now(timezone.utc) + timedelta(seconds=30)).timestamp()
        await _set_account_pause(far, "far")
        await _set_account_pause(near, "near")
        import pie_proxy_runtime as rt
        # The longer (far) pause must win — umans can extend but not shorten mid-pause.
        self.assertAlmostEqual(rt._ACCOUNT_PAUSED_UNTIL, far, places=0)


class TestCircuitBreakerMiddleware(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        import pie_proxy_runtime as rt
        rt._ACCOUNT_PAUSED_UNTIL = 0.0
        rt._ACCOUNT_PAUSE_MESSAGE = ""

    async def test_short_circuits_proxied_llm_path_when_paused(self):
        until = (datetime.now(timezone.utc) + timedelta(seconds=300)).timestamp()
        import pie_proxy_runtime as rt
        rt._ACCOUNT_PAUSED_UNTIL = until
        rt._ACCOUNT_PAUSE_MESSAGE = "test"

        called = False

        async def downstream(scope, receive, send):  # noqa: ANN001
            nonlocal called
            called = True

        sent: list[dict] = []

        async def send(message):
            sent.append(message)

        cb = AccountPauseCircuitBreaker(downstream)
        await cb({"type": "http", "path": "/v1/chat/completions"}, _noop_receive, send)
        # Downstream must NOT be called while paused.
        self.assertFalse(called, "downstream must not be called while account is paused")
        # A 429 + Retry-After must be sent.
        start = next(m for m in sent if m["type"] == "http.response.start")
        self.assertEqual(start["status"], 429)
        headers = dict(start["headers"])
        self.assertIn(b"retry-after", headers)
        body = next(m for m in sent if m["type"] == "http.response.body")
        payload = json.loads(body["body"].decode())
        self.assertEqual(payload["error"]["type"], "upstream_account_paused")

    async def test_health_endpoint_passes_through_when_paused(self):
        until = (datetime.now(timezone.utc) + timedelta(seconds=300)).timestamp()
        import pie_proxy_runtime as rt
        rt._ACCOUNT_PAUSED_UNTIL = until
        rt._ACCOUNT_PAUSE_MESSAGE = "test"

        called = False

        async def downstream(scope, receive, send):  # noqa: ANN001
            nonlocal called
            called = True
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok"})

        async def send(message):
            pass

        cb = AccountPauseCircuitBreaker(downstream)
        await cb({"type": "http", "path": "/health/liveness"}, _noop_receive, send)
        self.assertTrue(called, "health endpoints must not be short-circuited")

    async def test_learns_pause_from_429_response(self):
        learned = False

        async def downstream(scope, receive, send):  # noqa: ANN001
            await send({"type": "http.response.start", "status": 429, "headers": []})
            await send({"type": "http.response.body", "body": REAL_BODY})

        async def send(message):
            pass

        cb = AccountPauseCircuitBreaker(downstream)
        await cb({"type": "http", "path": "/v1/chat/completions"}, _noop_receive, send)
        # After seeing the suspension body, the pause must be armed.
        import pie_proxy_runtime as rt
        self.assertGreater(rt._ACCOUNT_PAUSED_UNTIL, 0.0)
        remaining = _account_paused_now()
        self.assertGreater(remaining, 1000, "reactivation ~hours away")

    async def test_streaming_2xx_passes_through_unchanged(self):
        chunks: list[bytes] = []

        async def downstream(scope, receive, send):  # noqa: ANN001
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"data: {\"x\":1}\n\n"})
            await send({"type": "http.response.body", "body": b"data: [DONE]\n\n", "more_body": False})

        async def send(message):
            if message.get("type") == "http.response.body":
                chunks.append(message.get("body") or b"")

        cb = AccountPauseCircuitBreaker(downstream)
        await cb({"type": "http", "path": "/v1/chat/completions"}, _noop_receive, send)
        self.assertEqual(b"".join(chunks), b"data: {\"x\":1}\n\ndata: [DONE]\n\n")
        import pie_proxy_runtime as rt
        self.assertEqual(rt._ACCOUNT_PAUSED_UNTIL, 0.0, "a 2xx stream must not arm the pause")


class TestPathClassification(unittest.TestCase):
    def test_proxied_llm_paths(self):
        self.assertTrue(_is_proxied_llm_path("/v1/chat/completions"))
        self.assertTrue(_is_proxied_llm_path("/v1/completions"))
        self.assertTrue(_is_proxied_llm_path("/v1/embeddings"))

    def test_non_llm_paths(self):
        self.assertFalse(_is_proxied_llm_path("/health/liveness"))
        self.assertFalse(_is_proxied_llm_path("/v1/models"))
        self.assertFalse(_is_proxied_llm_path("/health/proxy_metrics"))


class TestInstallIdempotent(unittest.TestCase):
    def test_install_is_idempotent(self):
        class FakeApp:
            def __init__(self):
                self.added: list = []

            def add_middleware(self, mw):
                self.added.append(mw)

        app = FakeApp()
        install_account_pause_circuit_breaker(app)  # type: ignore[arg-type]
        install_account_pause_circuit_breaker(app)  # type: ignore[arg-type]
        self.assertEqual(len(app.added), 1, "install must be idempotent")


async def _noop_receive():  # pragma: no cover - unused placeholder
    return {"type": "http.request", "body": b"", "more_body": False}


if __name__ == "__main__":
    unittest.main(verbosity=2)