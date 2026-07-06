"""
Regression test for the stream-liveness wrapper (Slice C of the hardening
plan: a dead upstream stream must surface as a terminal SSE error at the pie
litellm proxy instead of hanging the SDK's ``session.prompt()`` forever).

Hang class being prevented: a provider emits a chunk (e.g. a ``thinking``
block) then the upstream stream stalls — no chunk, no ``message_end``, no
error. Without the wrapper, the proxy forwards the streaming body_iterator
as-is and the SDK awaits the next chunk forever -> the parent session dangles.

The wrapper (``wrap_stream_with_liveness``) bounds each ``body_iterator``
chunk fetch with ``asyncio.wait_for(chunk, timeout=IDLE)``: on
``TimeoutError`` it yields a terminal SSE error event + ``[DONE]`` and stops.

Run:  cd "C:/Users/OwanLazic/Documents/GitHub/pie/proxy" && uv run python test/test_stream_liveness.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pie_proxy_runtime import (  # noqa: E402
    DEFAULT_STREAM_IDLE_TIMEOUT_S,
    _terminal_sse_error,
    resolve_stream_idle_timeout_s,
    wrap_stream_with_liveness,
)


async def _collect(chunks: list) -> list[bytes]:
    """Drain an async iterable into a list of bytes."""
    out: list[bytes] = []
    async for chunk in chunks:
        if isinstance(chunk, str):
            chunk = chunk.encode("utf-8")
        out.append(chunk)
    return out


async def _stalling_iterator(first_chunk: bytes, stall_seconds: float = 3600.0):
    """Yield one chunk, then sleep a very long time (simulates a dead upstream
    that emitted a chunk then stalled)."""
    yield first_chunk
    await asyncio.sleep(stall_seconds)


class StreamLivenessTests(unittest.IsolatedAsyncioTestCase):
    async def test_stalled_stream_yields_original_chunk_then_terminal_error_within_idle_window(self):
        # A stall: one real chunk, then a 1-hour sleep. With a tiny idle window
        # the wrapper MUST surface the original chunk, then a terminal SSE error
        # event + [DONE], then stop — well within the idle window.
        first = b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
        wrapped = wrap_stream_with_liveness(
            _stalling_iterator(first, stall_seconds=3600.0),
            idle_timeout_s=0.05,
            model="umans-glm-5.2:cloud",
        )
        collected = await asyncio.wait_for(_collect(wrapped), timeout=2.0)

        # First chunk passes through verbatim.
        self.assertEqual(collected[0], first)
        # Second chunk is the terminal SSE error + [DONE].
        self.assertGreaterEqual(len(collected), 2)
        terminal = collected[1]
        self.assertIn(b'"error"', terminal)
        self.assertIn(b'"upstream_stream_stalled"', terminal)
        self.assertIn(b"data: [DONE]", terminal)
        # No further chunks after the terminal event.
        self.assertEqual(len(collected), 2)

    async def test_disabled_timeout_forwards_chunks_unchanged(self):
        # idle_timeout_s=0 disables the liveness check — even a stall must pass
        # through (the wrapper must not inject errors when disabled).
        async def gen():
            yield b"data: a\n\n"
            yield b"data: [DONE]\n\n"

        wrapped = wrap_stream_with_liveness(gen(), idle_timeout_s=0)
        collected = await _collect(wrapped)
        self.assertEqual(collected, [b"data: a\n\n", b"data: [DONE]\n\n"])

    async def test_naturally_ending_stream_is_not_errored(self):
        # A stream that ends cleanly (StopAsyncIteration) must NOT get a
        # terminal error injected — only a stall does.
        async def gen():
            yield b"data: a\n\n"
            yield b"data: [DONE]\n\n"

        wrapped = wrap_stream_with_liveness(gen(), idle_timeout_s=0.05)
        collected = await _collect(wrapped)
        self.assertEqual(collected, [b"data: a\n\n", b"data: [DONE]\n\n"])

    async def test_wrapper_returns_promptly_on_stall(self):
        # The wrapper itself must settle within ~the idle window (not hang for
        # the 1-hour stall). This is the core guarantee: the parent SDK sees
        # stream termination quickly.
        wrapped = wrap_stream_with_liveness(
            _stalling_iterator(b"data: x\n\n", stall_seconds=3600.0),
            idle_timeout_s=0.05,
        )
        # If wrap_stream_with_liveness hung, this wait_for would time out.
        collected = await asyncio.wait_for(_collect(wrapped), timeout=2.0)
        self.assertGreaterEqual(len(collected), 2)
        self.assertIn(b"upstream_stream_stalled", collected[1])


class StreamLivenessConfigTests(unittest.TestCase):
    def test_default_when_unset(self):
        prev = os.environ.get("PIE_PROXY_STREAM_IDLE_TIMEOUT_S")
        os.environ.pop("PIE_PROXY_STREAM_IDLE_TIMEOUT_S", None)
        try:
            self.assertEqual(resolve_stream_idle_timeout_s(), float(DEFAULT_STREAM_IDLE_TIMEOUT_S))
        finally:
            if prev is not None:
                os.environ["PIE_PROXY_STREAM_IDLE_TIMEOUT_S"] = prev

    def test_zero_disables(self):
        prev = os.environ.get("PIE_PROXY_STREAM_IDLE_TIMEOUT_S")
        os.environ["PIE_PROXY_STREAM_IDLE_TIMEOUT_S"] = "0"
        try:
            self.assertEqual(resolve_stream_idle_timeout_s(), 0.0)
        finally:
            if prev is None:
                os.environ.pop("PIE_PROXY_STREAM_IDLE_TIMEOUT_S", None)
            else:
                os.environ["PIE_PROXY_STREAM_IDLE_TIMEOUT_S"] = prev

    def test_invalid_falls_back_to_default(self):
        prev = os.environ.get("PIE_PROXY_STREAM_IDLE_TIMEOUT_S")
        os.environ["PIE_PROXY_STREAM_IDLE_TIMEOUT_S"] = "not-a-number"
        try:
            self.assertEqual(resolve_stream_idle_timeout_s(), float(DEFAULT_STREAM_IDLE_TIMEOUT_S))
        finally:
            if prev is None:
                os.environ.pop("PIE_PROXY_STREAM_IDLE_TIMEOUT_S", None)
            else:
                os.environ["PIE_PROXY_STREAM_IDLE_TIMEOUT_S"] = prev

    def test_positive_value_honoured(self):
        prev = os.environ.get("PIE_PROXY_STREAM_IDLE_TIMEOUT_S")
        os.environ["PIE_PROXY_STREAM_IDLE_TIMEOUT_S"] = "30"
        try:
            self.assertEqual(resolve_stream_idle_timeout_s(), 30.0)
        finally:
            if prev is None:
                os.environ.pop("PIE_PROXY_STREAM_IDLE_TIMEOUT_S", None)
            else:
                os.environ["PIE_PROXY_STREAM_IDLE_TIMEOUT_S"] = prev


class TerminalSseErrorTests(unittest.TestCase):
    def test_terminal_error_payload_shape(self):
        payload = _terminal_sse_error(120.0)
        self.assertIsInstance(payload, bytes)
        text = payload.decode("utf-8")
        # Two SSE events: the error + [DONE].
        self.assertIn("data: ", text)
        self.assertIn('"upstream_stream_stalled"', text)
        self.assertIn("data: [DONE]", text)
        # The error payload must be valid JSON.
        json_part = text.split("\n\n")[0].removeprefix("data: ")
        parsed = json.loads(json_part)
        self.assertEqual(parsed["error"]["type"], "upstream_stream_stalled")
        self.assertIn("120s", parsed["error"]["message"])


if __name__ == "__main__":
    unittest.main()
