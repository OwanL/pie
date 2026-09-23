/**
 * Unit tests for the process-wide subagent concurrency gate.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { Semaphore, getMaxInflight, DEFAULT_MAX_INFLIGHT } from "../src/concurrency-limit.js";

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
// Semaphore
// ============================================================

test("Semaphore: permits up to capacity concurrent acquires", async () => {
	let running = 0;
	let maxRunning = 0;
	const sem = new Semaphore(() => 2);

	const work = async () => {
		const release = await sem.acquire();
		running++;
		maxRunning = Math.max(maxRunning, running);
		await new Promise((r) => setTimeout(r, 10));
		running--;
		release();
	};

	await Promise.all([work(), work(), work()]);
	assert.equal(maxRunning, 2);
});

test("Semaphore: extra acquires queue and resume FIFO", async () => {
	const order: number[] = [];
	const sem = new Semaphore(() => 1);

	const job = async (id: number) => {
		const release = await sem.acquire();
		order.push(id);
		await new Promise((r) => setTimeout(r, 5));
		release();
	};

	await Promise.all([job(1), job(2), job(3)]);
	assert.deepEqual(order, [1, 2, 3]);
});

test("Semaphore: release is idempotent", async () => {
	const sem = new Semaphore(() => 1);
	const release = await sem.acquire();
	release();
	release(); // should not double-count
	const release2 = await sem.acquire();
	release2();
	assert.ok(true);
});

test("Semaphore: dequeuing a waiter removes its abort listener", async () => {
	const sem = new Semaphore(() => 1);
	const held = await sem.acquire();
	const controller = new AbortController();
	const queued = sem.acquire(controller.signal);

	assert.equal(getEventListeners(controller.signal, "abort").length, 1);
	held();
	const releaseQueued = await queued;
	assert.equal(
		getEventListeners(controller.signal, "abort").length,
		0,
		"long-lived parent signals must not retain one listener per completed queued child",
	);
	releaseQueued();
});

test("Semaphore: capacity re-evaluated on each acquire", async () => {
	let capacity = 1;
	const sem = new Semaphore(() => capacity);

	const release = await sem.acquire();
	let resolved = false;
	const pending = sem.acquire().then((r) => {
		resolved = true;
		r();
	});
	await new Promise((r) => setTimeout(r, 5));
	assert.equal(resolved, false);
	capacity = 2;
	release();
	await pending;
	assert.equal(resolved, true);
});

test("Semaphore: raising capacity wakes existing waiters before a new caller", async () => {
	let capacity = 1;
	const sem = new Semaphore(() => capacity);
	const held = await sem.acquire();
	const order: number[] = [];
	const queued = [2, 3].map((id) => sem.acquire().then((release) => { order.push(id); return release; }));
	capacity = 4;
	const newcomer = sem.acquire().then((release) => { order.push(4); return release; });
	const releases = await Promise.all([...queued, newcomer]);
	assert.deepEqual(order, [2, 3, 4]);
	held();
	for (const release of releases) release();
});

test("Semaphore: lowering capacity does not transfer released permits above the new cap", async () => {
	let capacity = 2;
	const sem = new Semaphore(() => capacity);
	const first = await sem.acquire();
	const second = await sem.acquire();
	let thirdStarted = false;
	const thirdPromise = sem.acquire().then((release) => {
		thirdStarted = true;
		return release;
	});

	capacity = 1;
	first();
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(thirdStarted, false, "one existing holder still consumes the reduced capacity");

	second();
	const third = await thirdPromise;
	assert.equal(thirdStarted, true);
	third();
});

// ============================================================
// Env-aware limit helpers
// ============================================================

test("getMaxInflight: unset → DEFAULT_MAX_INFLIGHT", () => {
	delete process.env.PIE_SUBAGENT_MAX_INFLIGHT;
	assert.equal(getMaxInflight(), DEFAULT_MAX_INFLIGHT);
	assert.equal(DEFAULT_MAX_INFLIGHT, 2);
});

test("getMaxInflight: override honoured", () => {
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "4";
	assert.equal(getMaxInflight(), 4);
});

test("getMaxInflight: below 1 falls back to default", () => {
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "0";
	assert.equal(getMaxInflight(), DEFAULT_MAX_INFLIGHT);
});
