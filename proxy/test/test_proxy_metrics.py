import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pie_proxy_runtime import TrackedSemaphore


class TrackedSemaphoreTests(unittest.IsolatedAsyncioTestCase):
    async def test_counts_active_and_waiting(self):
        sem = TrackedSemaphore(1)

        await sem.acquire()
        self.assertEqual(sem.active, 1)
        self.assertEqual(sem.waiting, 0)

        waiter_started = asyncio.Event()
        release_waiter = asyncio.Event()

        async def waiter():
            waiter_started.set()
            await sem.acquire()
            try:
                await release_waiter.wait()
            finally:
                sem.release()

        task = asyncio.create_task(waiter())
        await waiter_started.wait()
        await asyncio.sleep(0)
        self.assertEqual(sem.active, 1)
        self.assertEqual(sem.waiting, 1)

        sem.release()
        await asyncio.sleep(0)
        self.assertEqual(sem.active, 1)
        self.assertEqual(sem.waiting, 0)

        release_waiter.set()
        await task
        self.assertEqual(sem.active, 0)
        self.assertEqual(sem.waiting, 0)


if __name__ == "__main__":
    unittest.main()
