"""Tests for the afterburn per-session sticky concurrency slot pool.

Covers the behavioural contract from the feature description:

  * A session that finishes an LLM call keeps its slot for ``afterburn`` seconds;
    a follow-up call from the SAME session within the window reuses it without
    queueing (``session continues afterward, the other session still paused``).
  * If the holder stays idle past ``afterburn``, a queued DIFFERENT session
    takes the slot (``session A gets queued/paused, session B turns active``).
  * Per-slot affinity generalises to ``size > 1`` (each slot sticks to its last
    session independently).
  * The acquire wait is bounded by ``afterburn_s + queue_wait_s``; on exceed it
    raises ``_AfterburnSaturated`` (the middleware turns this into a 503).
  * A FAILED response (non-2xx) frees the slot (no hold armed) so a dead
    upstream doesn't block other sessions.
  * Anonymous requests (no session id) never arm a hold.
  * When ``afterburn_s == 0`` the pool degenerates to a plain bounded gate (no
    sticky behaviour), and the middleware is a zero-cost pass-through when the
    pool registry is empty (afterburn globally disabled).

Run:  cd "C:/Users/OwanLazic/Documents/GitHub/pie/proxy" && uv run python test/test_afterburn.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pie_proxy_runtime as rt  # noqa: E402
from pie_proxy_runtime import (  # noqa: E402
    AfterburnASGIMiddleware,
    AfterburnPool,
    _AfterburnSaturated,
)


def _loop_time() -> float:
    return asyncio.get_event_loop().time()


class AfterburnPoolReuseTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_session_reuses_slot_within_afterburn(self):
        # size=1, afterburn=0.2s. Session A acquires, releases (success) ->
        # slot HELD by A. A re-acquires immediately -> reuses (no wait).
        pool = AfterburnPool(1, 0.2)
        slot = await pool.acquire("A")
        await pool.release(slot, "A", success=True)
        t0 = _loop_time()
        slot2 = await pool.acquire("A")
        elapsed = _loop_time() - t0
        self.assertEqual(slot2, slot)
        self.assertLess(elapsed, 0.05)
        self.assertEqual(pool.active, 1)
        self.assertEqual(pool.waiting, 0)
        await pool.release(slot2, "A", success=True)

    async def test_different_session_takes_slot_after_afterburn_expires(self):
        # size=1, afterburn short. A holds then releases (held). B arrives
        # during the hold -> B queues. After the hold expires, B acquires.
        pool = AfterburnPool(1, 0.1)
        slot = await pool.acquire("A")
        await pool.release(slot, "A", success=True)  # armed hold for A, 0.1s

        started = asyncio.Event()
        acquired = asyncio.Event()

        async def b_acquire():
            started.set()
            s = await pool.acquire("B")
            acquired.set()
            await pool.release(s, "B", success=True)

        task = asyncio.create_task(b_acquire())
        await started.wait()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(pool.waiting, 1)
        self.assertEqual(pool.active, 0)  # slot is HELD, not in-flight
        self.assertFalse(acquired.is_set())

        # Wait past the hold; B should acquire.
        await asyncio.wait_for(acquired.wait(), timeout=1.0)
        await task
        self.assertEqual(pool.waiting, 0)

    async def test_holder_priority_over_queued_session(self):
        # size=1, afterburn=0.3s. A holds+releases (held). B queues. A's
        # follow-up call arrives WHILE B is queued -> A reuses its held slot
        # (priority), B keeps waiting.
        pool = AfterburnPool(1, 0.3)
        slot = await pool.acquire("A")
        await pool.release(slot, "A", success=True)

        b_started = asyncio.Event()
        b_acquired = asyncio.Event()

        async def b_acquire():
            b_started.set()
            s = await pool.acquire("B")
            b_acquired.set()
            await pool.release(s, "B", success=True)

        b_task = asyncio.create_task(b_acquire())
        await b_started.wait()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(pool.waiting, 1)
        self.assertFalse(b_acquired.is_set())

        # A re-acquires immediately (reuses held slot) even with B queued.
        t0 = _loop_time()
        slot_a2 = await pool.acquire("A")
        self.assertLess(_loop_time() - t0, 0.05)
        self.assertEqual(slot_a2, slot)
        self.assertEqual(pool.active, 1)
        self.assertEqual(pool.waiting, 1)  # B still waiting
        await pool.release(slot_a2, "A", success=True)

        # Now let B proceed past the (re-armed) hold.
        await asyncio.wait_for(b_acquired.wait(), timeout=2.0)
        await b_task

    async def test_per_slot_affinity_for_size_two(self):
        # size=2, afterburn=0.3. A and B each hold a slot and release (both
        # held). C arrives -> C waits (both slots held). A re-acquires ->
        # reuses its slot; C still waits until a hold expires.
        pool = AfterburnPool(2, 0.3)
        sa = await pool.acquire("A")
        sb = await pool.acquire("B")
        self.assertNotEqual(sa, sb)
        await pool.release(sa, "A", success=True)
        await pool.release(sb, "B", success=True)
        self.assertEqual(pool.active, 0)

        c_started = asyncio.Event()
        c_acquired = asyncio.Event()

        async def c_acquire():
            c_started.set()
            s = await pool.acquire("C")
            c_acquired.set()
            await pool.release(s, "C", success=True)

        c_task = asyncio.create_task(c_acquire())
        await c_started.wait()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(pool.waiting, 1)
        self.assertFalse(c_acquired.is_set())

        # A reuses its slot instantly.
        sa2 = await pool.acquire("A")
        self.assertEqual(sa2, sa)
        await pool.release(sa2, "A", success=True)

        # C still waiting (re-armed A hold + B hold).
        await asyncio.sleep(0)
        self.assertFalse(c_acquired.is_set())

        # Eventually a hold expires and C acquires.
        await asyncio.wait_for(c_acquired.wait(), timeout=2.0)
        await c_task


class AfterburnPoolFailureAndAnonymousTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_response_frees_slot_no_hold(self):
        # A non-2xx (success=False) release frees the slot with no hold, so a
        # queued different session acquires immediately.
        pool = AfterburnPool(1, 10.0)
        slot = await pool.acquire("A")
        await pool.release(slot, "A", success=False)
        t0 = _loop_time()
        slot_b = await pool.acquire("B")
        self.assertLess(_loop_time() - t0, 0.05)
        await pool.release(slot_b, "B", success=True)

    async def test_anonymous_request_never_arms_hold(self):
        # session=None: release frees the slot (no hold), even on success.
        pool = AfterburnPool(1, 10.0)
        slot = await pool.acquire(None)
        await pool.release(slot, None, success=True)
        t0 = _loop_time()
        slot2 = await pool.acquire("X")
        self.assertLess(_loop_time() - t0, 0.05)
        await pool.release(slot2, "X", success=True)


class AfterburnPoolSaturatedTests(unittest.IsolatedAsyncioTestCase):
    """The acquire wait is bounded by afterburn_s + queue_wait_s; on exceed a
    ``_AfterburnSaturated`` is raised (the middleware returns a 503)."""

    def setUp(self) -> None:
        self._prev_qw = os.environ.get("PIE_PROXY_QUEUE_WAIT_S")
        self._prev_ab = os.environ.get("PIE_PROXY_AFTERBURN_S")
        os.environ["PIE_PROXY_QUEUE_WAIT_S"] = "0.05"

    def tearDown(self) -> None:
        for k, v in (("PIE_PROXY_QUEUE_WAIT_S", self._prev_qw), ("PIE_PROXY_AFTERBURN_S", self._prev_ab)):
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    async def test_acquire_raises_after_afterburn_plus_queue_bound(self):
        # size=1 held in-flight by A; B waits. The slot is IN_FLIGHT (not a
        # hold), so B's wait is bounded by afterburn + queue_wait.
        pool = AfterburnPool(1, 0.1)
        slot = await pool.acquire("A")
        with self.assertRaises(_AfterburnSaturated) as ctx:
            await pool.acquire("B")
        self.assertGreater(ctx.exception.wait_s, 0)
        await pool.release(slot, "A", success=True)

    async def test_disabled_queue_bound_still_bounded_by_afterburn_hold(self):
        # queue_wait=0 (disabled) but afterburn=0.1: a HELD slot still expires
        # within afterburn, so a queued session acquires (not raised).
        os.environ["PIE_PROXY_QUEUE_WAIT_S"] = "0"
        pool = AfterburnPool(1, 0.1)
        slot = await pool.acquire("A")
        await pool.release(slot, "A", success=True)
        slot_b = await asyncio.wait_for(pool.acquire("B"), timeout=1.0)
        await pool.release(slot_b, "B", success=True)


class AfterburnPoolDisabledTests(unittest.IsolatedAsyncioTestCase):
    async def test_afterburn_zero_acts_as_plain_bounded_gate(self):
        pool = AfterburnPool(1, 0.0)
        s = await pool.acquire("A")
        await pool.release(s, "A", success=True)
        t0 = _loop_time()
        s2 = await pool.acquire("B")
        self.assertLess(_loop_time() - t0, 0.05)
        await pool.release(s2, "B", success=True)

    async def test_afterburn_zero_saturates_within_queue_bound(self):
        os.environ["PIE_PROXY_QUEUE_WAIT_S"] = "0.05"
        try:
            pool = AfterburnPool(1, 0.0)
            s = await pool.acquire("A")
            with self.assertRaises(_AfterburnSaturated):
                await pool.acquire("B")
            await pool.release(s, "A", success=True)
        finally:
            os.environ.pop("PIE_PROXY_QUEUE_WAIT_S", None)


class AfterburnMiddlewareTests(unittest.IsolatedAsyncioTestCase):
    """Drive the raw ASGI middleware with a fake downstream + a real pool to
    verify slot acquire/release + the hold armed at response completion."""

    def setUp(self) -> None:
        # Stash the global pool registry + resolver so the early-exit fast path
        # (``if not _AFTERBURN_POOLS``) doesn't bypass the resolver, and so tests
        # don't leak state into each other / the real proxy.
        self._saved_pools = dict(rt._AFTERBURN_POOLS)
        rt._AFTERBURN_POOLS.clear()
        self._saved_resolver = rt._resolve_pool_for_request

    def tearDown(self) -> None:
        rt._AFTERBURN_POOLS.clear()
        rt._AFTERBURN_POOLS.update(self._saved_pools)
        rt._resolve_pool_for_request = self._saved_resolver
        os.environ.pop("PIE_PROXY_QUEUE_WAIT_S", None)

    def _install_pool(self, pool) -> None:
        """Register `pool` so the middleware's early-exit doesn't fire and point
        the resolver at it."""
        rt._AFTERBURN_POOLS["umans"] = pool
        rt._resolve_pool_for_request = lambda body: pool

    def _make_scope(self, path="/v1/chat/completions", session="A", model="umans-glm-5.2"):
        scope = {"type": "http", "path": path, "headers": []}
        if session is not None:
            scope["headers"].append((b"x-session-affinity", session.encode()))
        return scope, self._make_body(model)

    def _make_body(self, model):
        body = json.dumps({"model": model, "messages": []}).encode()

        async def receive():
            return {"type": "http.request", "body": body, "more_body": False}

        return receive

    async def _run_downstream(self, scope, receive, pool, downstream_status, stream):
        self._install_pool(pool)
        mw = AfterburnASGIMiddleware(app=None)

        async def downstream(scope, receive, send):
            await send({
                "type": "http.response.start",
                "status": downstream_status,
                "headers": [(b"content-type", b"text/event-stream")],
            })
            if stream:
                await send({"type": "http.response.body", "body": b"data: chunk1\n\n", "more_body": True})
                await send({"type": "http.response.body", "body": b"data: [DONE]\n\n", "more_body": False})
            else:
                await send({"type": "http.response.body", "body": b"ok", "more_body": False})

        mw.app = downstream
        sent = []

        async def send(message):
            sent.append(message)

        await mw(scope, receive, send)
        return sent

    async def test_middleware_arms_hold_on_2xx_stream_completion(self):
        scope, receive = self._make_scope(session="A")
        pool = AfterburnPool(1, 10.0)
        await self._run_downstream(scope, receive, pool, downstream_status=200, stream=True)
        # After a 200 stream completes, the slot is HELD by A (not in-flight),
        # so a follow-up A call reuses it instantly while B would queue.
        self.assertEqual(pool.active, 0)
        t0 = _loop_time()
        slot = await pool.acquire("A")  # reuse held slot
        self.assertLess(_loop_time() - t0, 0.05)
        await pool.release(slot, "A", success=True)

    async def test_middleware_frees_slot_on_non_2xx(self):
        scope, receive = self._make_scope(session="A")
        pool = AfterburnPool(1, 10.0)
        await self._run_downstream(scope, receive, pool, downstream_status=504, stream=False)
        # Non-2xx -> slot freed (no hold). A different session acquires at once.
        self.assertEqual(pool.active, 0)
        t0 = _loop_time()
        slot = await pool.acquire("B")
        self.assertLess(_loop_time() - t0, 0.05)
        await pool.release(slot, "B", success=True)

    async def test_middleware_frees_slot_when_downstream_raises(self):
        pool = AfterburnPool(1, 10.0)
        self._install_pool(pool)
        scope, receive = self._make_scope(session="A")
        mw = AfterburnASGIMiddleware(app=None)

        async def downstream(scope, receive, send):
            raise RuntimeError("downstream blew up")

        mw.app = downstream
        sent = []

        async def send(message):
            sent.append(message)

        with self.assertRaises(RuntimeError):
            await mw(scope, receive, send)
        # Slot released free by the finally -> no leak, no hold.
        self.assertEqual(pool.active, 0)
        slot = await pool.acquire("B")  # immediate
        await pool.release(slot, "B", success=True)

    async def test_middleware_passthrough_when_pool_none(self):
        # Unknown model -> resolver returns None -> downstream called directly,
        # no pool touched. (Pool registry non-empty so the early-exit doesn't
        # fire; the resolver itself decides.)
        pool = AfterburnPool(1, 10.0)
        rt._AFTERBURN_POOLS["umans"] = pool  # non-empty so early-exit skipped
        # Real resolver: unknown model -> None.
        scope, receive = self._make_scope(model="not-a-real-model")
        called = {"v": False}

        async def downstream(scope, receive, send):
            called["v"] = True
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"x", "more_body": False})

        mw = AfterburnASGIMiddleware(app=downstream)
        sent = []

        async def send(message):
            sent.append(message)

        await mw(scope, receive, send)
        self.assertTrue(called["v"])
        # No slot was acquired (resolver returned None).
        self.assertEqual(pool.active, 0)

    async def test_middleware_zero_cost_passthrough_when_registry_empty(self):
        # Empty pool registry -> early-exit pass-through: downstream gets the
        # ORIGINAL receive (no body buffering), and the resolver is never
        # called.
        rt._AFTERBURN_POOLS.clear()  # ensure empty -> early exit
        resolver_called = {"v": False}
        orig = rt._resolve_pool_for_request
        rt._resolve_pool_for_request = lambda body: resolver_called.__setitem__("v", True) or None
        try:
            scope, receive = self._make_scope(session="A")
            saw_body = {"v": None}

            async def downstream(scope, receive, send):
                # Drain the original receive to confirm it's the un-buffered one.
                msg = await receive()
                saw_body["v"] = msg.get("body")
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await send({"type": "http.response.body", "body": b"ok", "more_body": False})

            mw = AfterburnASGIMiddleware(app=downstream)
            sent = []

            async def send(message):
                sent.append(message)

            await mw(scope, receive, send)
            self.assertFalse(resolver_called["v"])  # early-exit skipped resolve
            self.assertIsNotNone(saw_body["v"])  # downstream got the body
        finally:
            rt._resolve_pool_for_request = orig

    async def test_middleware_503_on_saturated_pool(self):
        pool = AfterburnPool(1, 10.0)
        held = await pool.acquire("A")  # hold the only slot in-flight
        self._install_pool(pool)
        os.environ["PIE_PROXY_QUEUE_WAIT_S"] = "0.05"
        scope, receive = self._make_scope(session="B")
        mw = AfterburnASGIMiddleware(app=None)

        async def downstream(scope, receive, send):  # pragma: no cover
            raise AssertionError("downstream should not run on 503")

        mw.app = downstream
        sent = []

        async def send(message):
            sent.append(message)

        await mw(scope, receive, send)
        start = sent[0]
        self.assertEqual(start["type"], "http.response.start")
        self.assertEqual(start["status"], 503)
        headers = dict((k.decode(), v.decode()) for k, v in start["headers"])
        self.assertIn("retry-after", headers)
        await pool.release(held, "A", success=True)


class AfterburnConfigTests(unittest.TestCase):
    def test_resolve_provider_afterburn_uses_override_then_env_default(self):
        os.environ.pop("PIE_PROXY_AFTERBURN_S", None)
        self.assertEqual(rt._resolve_provider_afterburn_s({}), 0.0)
        self.assertEqual(rt._resolve_provider_afterburn_s({"afterburnSeconds": 7}), 7.0)
        self.assertEqual(rt._resolve_provider_afterburn_s({"afterburnSeconds": -1}), 0.0)
        os.environ["PIE_PROXY_AFTERBURN_S"] = "12"
        try:
            self.assertEqual(rt._resolve_provider_afterburn_s({}), 12.0)
        finally:
            os.environ.pop("PIE_PROXY_AFTERBURN_S", None)


if __name__ == "__main__":
    unittest.main()