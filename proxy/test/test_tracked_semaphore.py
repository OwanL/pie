"""
Edge-case coverage for ``TrackedSemaphore`` — the semaphore LiteLLM's
concurrency governor is wrapped with so the proxy metrics endpoint can report
exact active + queued counts.

The existing ``test_proxy_metrics.py`` covers the single happy path
(Semaphore(1), one holder, one waiter). This file nails down the contracts
that are easy to silently break:

  * ``active`` is derived as ``max(0, initial_value - _value)`` and must CLAMP
    at 0 — an over-release (release without a matching acquire, or a release
    after the slot was already returned) must never surface a negative active
    count to the UI.
  * ``waiting`` is only incremented on the ``_value <= 0`` branch. When a slot
    is immediately available (``_value > 0``) ``acquire`` must NOT bump the
    queued counter — otherwise the UI would show phantom queued requests.
  * With ``value > 1`` multiple slots can be held concurrently and ``active``
    must reflect the exact number held.
  * Multiple concurrent waiters must each register on ``waiting`` and drain
    one-at-a-time as slots are released.
  * ``initial_value`` is preserved (the metrics endpoint relies on it for the
    ``active`` derivation).

Run:  cd "C:/Users/OwanLazic/Documents/GitHub/pie/proxy" && uv run python test/test_tracked_semaphore.py
"""

from __future__ import annotations

import asyncio
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pie_proxy_runtime import TrackedSemaphore  # noqa: E402


class TrackedSemaphoreActiveTests(unittest.IsolatedAsyncioTestCase):
    async def test_value_gt_one_tracks_multiple_active_slots(self):
        # Semaphore(3): two acquires => active==2, one slot still free.
        sem = TrackedSemaphore(3)
        await sem.acquire()
        await sem.acquire()
        self.assertEqual(sem.initial_value, 3)
        self.assertEqual(sem.active, 2)
        self.assertEqual(sem.waiting, 0)
        sem.release()
        sem.release()
        self.assertEqual(sem.active, 0)

    async def test_active_clamps_at_zero_on_over_release(self):
        # Releasing more than was acquired pushes ``_value`` above
        # ``initial_value``; ``active`` (= max(0, initial_value - _value)) must
        # CLAMP at 0 and never surface a negative count to the UI.
        sem = TrackedSemaphore(2)
        # No acquire happens — a stray release over-returns a slot.
        sem.release()
        self.assertLessEqual(sem.active, 0)  # clamped, not negative
        # A second stray release must still clamp, not go to -2.
        sem.release()
        self.assertEqual(sem.active, 0)
        # An acquire consumes a (phantom) slot but active must stay >= 0.
        await sem.acquire()
        self.assertGreaterEqual(sem.active, 0)

    async def test_acquire_with_slot_available_does_not_increment_waiting(self):
        # The queued counter must only move on the _value <= 0 branch.
        sem = TrackedSemaphore(2)
        await sem.acquire()
        await sem.acquire()
        # Both acquires found a free slot — no queuing.
        self.assertEqual(sem.waiting, 0)
        self.assertEqual(sem.active, 2)
        sem.release()
        sem.release()


class TrackedSemaphoreWaitingTests(unittest.IsolatedAsyncioTestCase):
    async def test_waiting_increments_only_when_no_slot(self):
        # value=1, held; a second acquire must block and bump waiting to 1,
        # then drop back to 0 once the slot is released and the waiter proceeds.
        sem = TrackedSemaphore(1)
        await sem.acquire()
        self.assertEqual(sem.waiting, 0)

        started = asyncio.Event()
        proceed = asyncio.Event()

        async def waiter():
            started.set()
            await sem.acquire()
            proceed.set()
            sem.release()

        task = asyncio.create_task(waiter())
        await started.wait()
        # Let the waiter park on the semaphore.
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(sem.waiting, 1)
        self.assertEqual(sem.active, 1)

        sem.release()
        await proceed.wait()
        await task
        self.assertEqual(sem.waiting, 0)
        self.assertEqual(sem.active, 0)

    async def test_multiple_waiters_queue_exactly(self):
        # value=1 held; N waiters park => waiting==N. Releasing the holder
        # hands the slot to exactly one waiter (FIFO) which HOLDS it until we
        # tell it to release, so we can observe waiting drop by exactly one
        # per slot handoff — no racing self-release.
        sem = TrackedSemaphore(1)
        await sem.acquire()

        N = 4
        acquired_order: list[int] = []
        acquired_events = [asyncio.Event() for _ in range(N)]
        release_events = [asyncio.Event() for _ in range(N)]

        async def waiter(i: int):
            await sem.acquire()
            acquired_order.append(i)
            acquired_events[i].set()
            await release_events[i].wait()
            sem.release()

        tasks = [asyncio.create_task(waiter(i)) for i in range(N)]
        # Let all waiters park.
        for _ in range(3):
            await asyncio.sleep(0)
        self.assertEqual(sem.waiting, N)
        self.assertEqual(sem.active, 1)

        # Release the holder; waiter 0 should acquire, hold, and waiting drops
        # by exactly one.
        sem.release()
        await acquired_events[0].wait()
        await asyncio.sleep(0)
        self.assertEqual(sem.waiting, N - 1)
        self.assertEqual(sem.active, 1)
        self.assertEqual(acquired_order, [0])

        # Tell waiter 0 to release -> waiter 1 acquires, waiting drops again.
        release_events[0].set()
        await acquired_events[1].wait()
        await asyncio.sleep(0)
        self.assertEqual(sem.waiting, N - 2)
        self.assertEqual(acquired_order, [0, 1])

        # Release the rest in order and let everyone finish.
        for i in range(1, N):
            release_events[i].set()
        await asyncio.gather(*tasks)
        self.assertEqual(sem.waiting, 0)
        self.assertEqual(sem.active, 0)
        self.assertEqual(acquired_order, list(range(N)))

    async def test_waiting_does_not_leak_across_consecutive_acquires(self):
        # A waiter that acquires then releases must leave waiting==0 so a later
        # waiter sees a clean queued counter (regression guard for the
        # try/finally in the _value <= 0 branch).
        sem = TrackedSemaphore(1)
        for _ in range(3):
            started = asyncio.Event()
            done = asyncio.Event()

            async def waiter():
                started.set()
                await sem.acquire()
                sem.release()
                done.set()

            await sem.acquire()
            task = asyncio.create_task(waiter())
            await started.wait()
            await asyncio.sleep(0)
            self.assertEqual(sem.waiting, 1)
            sem.release()
            await done.wait()
            await task
            self.assertEqual(sem.waiting, 0)
            self.assertEqual(sem.active, 0)


class TrackedSemaphoreQueueBoundTests(unittest.IsolatedAsyncioTestCase):
    """The queue-wait bound turns a saturated pool into a retryable 503 instead
    of an unbounded queue (or the header-phase middleware's opaque 120s-then-
    504). Driven by ``PIE_PROXY_QUEUE_WAIT_S``; ``0`` disables it."""

    def setUp(self) -> None:
        self._prev = os.environ.get("PIE_PROXY_QUEUE_WAIT_S")
        os.environ["PIE_PROXY_QUEUE_WAIT_S"] = "0.05"  # 50ms bound for fast tests

    def tearDown(self) -> None:
        if self._prev is None:
            os.environ.pop("PIE_PROXY_QUEUE_WAIT_S", None)
        else:
            os.environ["PIE_PROXY_QUEUE_WAIT_S"] = self._prev

    async def test_acquire_raises_503_when_no_slot_frees_within_bound(self):
        sem = TrackedSemaphore(1)
        await sem.acquire()  # hold the only slot
        self.assertEqual(sem.waiting, 0)

        with self.assertRaises(Exception) as ctx:
            await sem.acquire()
        err = ctx.exception
        # ProxyException carries code="503" + Retry-After header (duck-typed so
        # the test doesn't need to import the litellm proxy package).
        self.assertEqual(getattr(err, "code", None), "503")
        headers = getattr(err, "headers", {}) or {}
        self.assertIn("Retry-After", headers)
        # queued counter restored; no leak.
        self.assertEqual(sem.waiting, 0)
        self.assertEqual(sem.active, 1)

    async def test_acquire_succeeds_when_slot_frees_within_bound(self):
        sem = TrackedSemaphore(1)
        await sem.acquire()

        async def releaser():
            await asyncio.sleep(0.01)  # 10ms - well within the 50ms bound
            sem.release()

        asyncio.create_task(releaser())
        # Should acquire the freed slot, not raise.
        await sem.acquire()
        self.assertEqual(sem.active, 1)
        self.assertEqual(sem.waiting, 0)
        # Clean up the slot we now hold.
        sem.release()

    async def test_no_poison_after_timeout_then_release_succeeds(self):
        # A timed-out acquire must NOT leak a permit: after the timeout, when the
        # holder releases, a fresh acquire must proceed immediately (the pool is
        # not permanently disabled by the prior queue timeout).
        sem = TrackedSemaphore(1)
        await sem.acquire()
        with self.assertRaises(Exception):
            await sem.acquire()
        # Holder releases - the slot is now free.
        sem.release()
        self.assertEqual(sem.active, 0)
        await sem.acquire()  # immediate, no raise
        self.assertEqual(sem.active, 1)
        sem.release()

    async def test_disabled_bound_does_not_raise_promptly(self):
        # PIE_PROXY_QUEUE_WAIT_S=0 disables the bound; a waiter parks (does not
        # raise within the test window) and proceeds when the slot is released.
        os.environ["PIE_PROXY_QUEUE_WAIT_S"] = "0"
        sem = TrackedSemaphore(1)
        await sem.acquire()

        proceeded = asyncio.Event()

        async def waiter():
            await sem.acquire()
            proceeded.set()
            sem.release()

        task = asyncio.create_task(waiter())
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(sem.waiting, 1)
        # Has NOT raised - the task is still pending (not done).
        self.assertFalse(task.done())
        sem.release()
        await asyncio.wait_for(proceeded.wait(), timeout=1.0)
        await task


if __name__ == "__main__":
    unittest.main()
()