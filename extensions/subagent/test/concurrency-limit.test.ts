/**
 * Unit tests for the process-wide subagent concurrency gate.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Semaphore, getMaxInflight, getMaxConcurrency, getMaxParallelTasks, DEFAULT_MAX_INFLIGHT } from "../src/concurrency-limit.js";
import { MAX_CONCURRENCY, MAX_PARALLEL_TASKS } from "../types.js";

const ENV_KEYS = [
	"PIE_SUBAGENT_MAX_INFLIGHT",
	"PIE_SUBAGENT_MAX_CONCURRENCY",
	"PIE_SUBAGENT_MAX_PARALLEL_TASKS",
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

test("getMaxConcurrency: unset → MAX_CONCURRENCY", () => {
	delete process.env.PIE_SUBAGENT_MAX_CONCURRENCY;
	assert.equal(getMaxConcurrency(), MAX_CONCURRENCY);
	assert.equal(MAX_CONCURRENCY, 2);
});

test("getMaxConcurrency: override honoured", () => {
	process.env.PIE_SUBAGENT_MAX_CONCURRENCY = "3";
	assert.equal(getMaxConcurrency(), 3);
});

test("getMaxParallelTasks: unset → MAX_PARALLEL_TASKS", () => {
	delete process.env.PIE_SUBAGENT_MAX_PARALLEL_TASKS;
	assert.equal(getMaxParallelTasks(), MAX_PARALLEL_TASKS);
	assert.equal(MAX_PARALLEL_TASKS, 4);
});

test("getMaxParallelTasks: override honoured", () => {
	process.env.PIE_SUBAGENT_MAX_PARALLEL_TASKS = "6";
	assert.equal(getMaxParallelTasks(), 6);
});
