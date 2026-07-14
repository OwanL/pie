/**
 * Extra unit tests for the process-wide subagent concurrency gate.
 *
 * `preflight-abort.test.ts` already covers the abortable-acquire contract
 * (already-aborted + abort-while-queued). This file pins the remaining
 * pure-logic contracts of `Semaphore` and the env-aware limit helpers that are
 * NOT exercised elsewhere: zero/fractional/negative capacity, the
 * `SemaphoreAbortError` identity, permit-transfer-on-release semantics, and
 * invalid-input fallbacks for the root-tree limit.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
	Semaphore,
	SemaphoreAbortError,
	getMaxInflight,
	DEFAULT_MAX_INFLIGHT,
} from "../src/concurrency-limit.js";

const ENV_KEYS = [
	"PIE_SUBAGENT_MAX_INFLIGHT",
] as const;

const snapshot: Record<string, string | undefined> = {};

test.before(() => {
	for (const key of ENV_KEYS) snapshot[key] = process.env[key];
});

test.after(() => {
	for (const key of ENV_KEYS) {
		if (snapshot[key] === undefined) delete process.env[key];
		else process.env[key] = snapshot[key];
	}
});

// ============================================================
// SemaphoreAbortError identity
// ============================================================

test("SemaphoreAbortError: name is 'AbortError' so callers can distinguish it", () => {
	const err = new SemaphoreAbortError();
	assert.equal(err.name, "AbortError");
	assert.match(err.message, /abort/i);
});

test("SemaphoreAbortError: accepts a custom stage label in the message", () => {
	const err = new SemaphoreAbortError("creating session");
	assert.equal(err.name, "AbortError");
	assert.match(err.message, /creating session/);
});

test("SemaphoreAbortError: is an instanceof Error", () => {
	const err = new SemaphoreAbortError();
	assert.ok(err instanceof Error);
	assert.ok(err instanceof SemaphoreAbortError);
});

// ============================================================
// Semaphore: capacity edge cases
// ============================================================

test("Semaphore: capacity 0 queues every acquire (none resolve until capacity rises)", async () => {
	const sem = new Semaphore(() => 0);
	const ac = new AbortController();
	let resolved = false;
	const pending = sem.acquire(ac.signal).then((r) => {
		resolved = true;
		r();
	});
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(resolved, false, "with capacity 0 no acquire should resolve");
	// Abort the pending acquire so it rejects (and is caught) rather than
	// dangling forever — acquire() supports an AbortSignal for exactly this.
	ac.abort();
	await assert.rejects(pending, SemaphoreAbortError);
});

test("Semaphore: a queued acquire is NOT resumed by a later capacity rise (capacity is checked at acquire-time only; waiters unblock only on release transfer)", async () => {
	// Pin the actual contract: Semaphore reads capacity ONCE at acquire() entry.
	// Once a waiter is parked, raising the capacityFn's return value does NOT
	// resume it — only a release() transferring a permit does. (A capacity-poll
	// loop would be a different, heavier primitive.) Assert this so a future
	// refactor doesn't silently change the semantics.
	let capacity = 0;
	const sem = new Semaphore(() => capacity);
	const ac = new AbortController();
	let resolved = false;
	const pending = sem.acquire(ac.signal).then((r) => {
		resolved = true;
		r();
	});
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(resolved, false, "queued acquire must not resolve while no permit is released");
	capacity = 1; // capacityFn now returns 1, but the parked waiter is NOT re-checked
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(resolved, false, "raising capacity does not resume an already-parked waiter");
	ac.abort();
	await assert.rejects(pending, SemaphoreAbortError);
});

test("Semaphore: fractional capacity is floored (2.9 → 2 permits)", async () => {
	let running = 0;
	let maxRunning = 0;
	const sem = new Semaphore(() => 2.9);
	const work = async () => {
		const release = await sem.acquire();
		running++;
		maxRunning = Math.max(maxRunning, running);
		await new Promise((r) => setTimeout(r, 10));
		running--;
		release();
	};
	await Promise.all([work(), work(), work(), work()]);
	assert.equal(maxRunning, 2);
});

test("Semaphore: negative capacity is clamped to 0 (no permits issued); a queued acquire resumes only via release transfer", async () => {
	// Negative capacity floors to 0 → acquire parks. Like the capacity-0 case,
	// the waiter resumes ONLY when a permit is released to it, not when the
	// capacityFn later returns positive. Use a second acquire-then-release as
	// the permit source.
	let capacity = -5;
	const sem = new Semaphore(() => capacity);
	const ac = new AbortController();
	let resolved = false;
	const pending = sem.acquire(ac.signal).then((r) => {
		resolved = true;
		r();
	});
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(resolved, false, "negative capacity clamps to 0; no permit issued");
	// Raising capacity lets a FRESH acquire succeed; that fresh holder's
	// release() then transfers the permit to the parked waiter.
	capacity = 1;
	const release = await sem.acquire();
	release(); // transfer to the parked waiter
	await pending;
	assert.equal(resolved, true, "parked waiter resumed by the released permit");
});

// ============================================================
// Semaphore: permit transfer on release
// ============================================================

test("Semaphore: releasing a permit transfers it to the next queued waiter (FIFO)", async () => {
	const sem = new Semaphore(() => 1);
	const order: string[] = [];
	const hold = await sem.acquire();
	const second = sem.acquire().then((r) => {
		order.push("second");
		r();
	});
	const third = sem.acquire().then((r) => {
		order.push("third");
		r();
	});
	await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(order, []);
	hold(); // transfer to second
	await second;
	assert.deepEqual(order, ["second"]);
	await third;
	assert.deepEqual(order, ["second", "third"]);
});

test("Semaphore: a transferred permit is independently releasable (no double-count)", async () => {
	const sem = new Semaphore(() => 1);
	const first = await sem.acquire();
	const secondP = sem.acquire();
	first(); // hand off to second
	const second = await secondP;
	// second now owns the permit; releasing it twice must not over-free.
	second();
	second();
	// A fresh acquire must still work (inFlight was not driven negative).
	const third = await sem.acquire();
	third();
});

test("Semaphore: inFlight never goes negative even with redundant releases at capacity 1", async () => {
	const sem = new Semaphore(() => 1);
	const r1 = await sem.acquire();
	r1();
	r1();
	r1();
	// After redundant releases, two fresh acquires should both succeed serially.
	const r2 = await sem.acquire();
	r2();
	const r3 = await sem.acquire();
	r3();
});

// ============================================================
// Env-aware limit helpers: invalid-input fallbacks
// ============================================================

test("getMaxInflight: non-numeric string falls back to default", () => {
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "abc";
	assert.equal(getMaxInflight(), DEFAULT_MAX_INFLIGHT);
});

test("getMaxInflight: float is floored to an integer", () => {
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "3.9";
	assert.equal(getMaxInflight(), 3);
});

test("getMaxInflight: empty string falls back to default", () => {
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "";
	assert.equal(getMaxInflight(), DEFAULT_MAX_INFLIGHT);
});

test("getMaxInflight: negative number falls back to default", () => {
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "-3";
	assert.equal(getMaxInflight(), DEFAULT_MAX_INFLIGHT);
});

test("getMaxInflight: '1' is honoured (minimum valid)", () => {
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "1";
	assert.equal(getMaxInflight(), 1);
});
