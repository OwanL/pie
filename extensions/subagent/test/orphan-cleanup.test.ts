/**
 * REM-02 + orphan-registry/shutdown-drain tests.
 *
 * Scenarios:
 *  - session creation loses the abort/timeout race and resolves later;
 *  - the late session is disposed exactly once and never reaches setup/prompt;
 *  - the orphan registry retries dispose failures/hangs with bounded backoff;
 *  - the registry drains best-effort and exposes observable stats;
 *  - subsequent capacity-one work proceeds because the permit was released.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { runSingleAgent } from "../runner.js";
import { OrphanCleanupRegistry, type CleanupScheduler } from "../src/cleanup.js";
import type { AgentConfig } from "../agents.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "test agent",
		systemPrompt: "",
		source: "user",
		filePath: "worker.md",
		...overrides,
	};
}

function makeModelRegistry() {
	const model = { id: "model-a", provider: "test" } as any;
	return {
		getAvailable: () => [model],
		getAll: () => [model],
		find: (_p: string, id: string) => (id === model.id ? model : undefined),
	} as any;
}

const makeDetails = () => (results: any[]) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results });

function within<T>(ms: number, p: Promise<T>): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms)),
	]);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const INFLIGHT_ENV = "PIE_SUBAGENT_MAX_INFLIGHT";
let savedInflight: string | undefined;

test.before(() => { savedInflight = process.env[INFLIGHT_ENV]; });
test.after(() => {
	if (savedInflight === undefined) delete process.env[INFLIGHT_ENV];
	else process.env[INFLIGHT_ENV] = savedInflight;
});

// ---------------------------------------------------------------------------
// Registry unit-test scheduler
// ---------------------------------------------------------------------------

class FakeScheduler implements CleanupScheduler {
	private timers: Array<{ deadline: number; resolve: () => void }> = [];
	readonly referencedTimers: boolean[] = [];
	nowMs = 0;

	now(): number {
		return this.nowMs;
	}

	setTimer(ms: number, referenced = false): { promise: Promise<void>; cancel: () => void } {
		this.referencedTimers.push(referenced);
		const deadline = this.nowMs + ms;
		let resolve!: () => void;
		const promise = new Promise<void>((r) => {
			resolve = r;
		});
		const timer = { deadline, resolve };
		this.timers.push(timer);
		return {
			promise,
			cancel: () => {
				this.timers = this.timers.filter((t) => t !== timer);
			},
		};
	}

	async advance(ms: number): Promise<void> {
		const target = this.nowMs + ms;
		let safety = 0;
		while (this.nowMs < target && safety < 1_000) {
			safety++;
			// Fire only the next timer at or before the target, updating nowMs
			// to its deadline so timers created during resolution use the correct
			// base time (e.g. retry/backoff delays).
			const next = this.timers
				.filter((t) => t.deadline <= target)
				.sort((a, b) => a.deadline - b.deadline)[0];
			if (!next) {
				this.nowMs = target;
				break;
			}
			this.nowMs = next.deadline;
			this.timers = this.timers.filter((t) => t !== next);
			next.resolve();
			// Yield to the event loop so microtasks from the fired timer (e.g.
			// retry scheduling) run before we look for the next ready timer.
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
	}

	cancelAll(): void {
		this.timers = [];
	}
}

// ---------------------------------------------------------------------------
// Mock SDKs
// ---------------------------------------------------------------------------

/** A SDK whose `createSession` hangs until `resolveCreate()` is called. */
function createLateCreateSdk(dispose?: () => void) {
	let resolveCreate: (value: { session: unknown }) => void = () => {};
	const createSessionPromise = new Promise<{ session: unknown }>((resolve) => {
		resolveCreate = resolve;
	});
	const state = {
		createSessionCalls: 0,
		disposeCalls: 0,
		setUIContextCalls: 0,
		subscribeCalls: 0,
		promptCalls: 0,
	};
	const session = {
		agent: { state: { model: { id: "session-model" } } },
		extensionRunner: {
			setUIContext: () => {
				state.setUIContextCalls++;
				throw new Error("setUIContext must not be reached for an orphan");
			},
		},
		subscribe: () => {
			state.subscribeCalls++;
			throw new Error("subscribe must not be reached for an orphan");
		},
		prompt: async () => {
			state.promptCalls++;
			throw new Error("prompt must not be reached for an orphan");
		},
		abort: async () => {},
		dispose: () => {
			state.disposeCalls++;
			dispose?.();
		},
	};
	return {
		sdk: {
			createSession: async () => {
				state.createSessionCalls++;
				return createSessionPromise;
			},
			createResourceLoader: () => ({ reload: async () => {} }),
			createSessionManager: () => ({}),
			getAgentDir: () => ".",
		},
		state,
		resolveCreate: (customSession = session) => resolveCreate({ session: customSession }),
	};
}

/** A fast SDK for the capacity-one follow-up assertion. */
function createFastSdk() {
	const state = { createSessionCalls: 0 };
	const listeners: Array<(event: any) => void> = [];
	const session = {
		agent: { state: { model: { id: "session-model" } } },
		extensionRunner: { setUIContext: () => {} },
		subscribe: (cb: any) => { listeners.push(cb); return () => {}; },
		prompt: async () => {
			const emit = (event: any) => { for (const l of listeners) l(event); };
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
					model: "m",
					stopReason: "completed",
				},
			});
		},
		abort: async () => {},
		dispose: () => {},
	};
	return {
		sdk: {
			createSession: async () => { state.createSessionCalls++; return { session }; },
			createResourceLoader: () => ({ reload: async () => {} }),
			createSessionManager: () => ({}),
			getAgentDir: () => ".",
		},
		state,
	};
}

// ---------------------------------------------------------------------------
// Registry unit tests
// ---------------------------------------------------------------------------

test("OrphanCleanupRegistry: retries dispose failures with bounded exponential backoff", async () => {
	const scheduler = new FakeScheduler();
	const registry = new OrphanCleanupRegistry(
		{
			maxEntries: 8,
			initialRetryMs: 100,
			maxRetryMs: 500,
			retryMultiplier: 2,
			maxAttempts: 4,
			cleanupTimeoutMs: 1_000,
		},
		scheduler,
	);

	let attempts = 0;
	const cleanup = async () => {
		attempts++;
		throw new Error(`dispose failure ${attempts}`);
	};

	registry.register("attempt-1", cleanup);
	await sleep(5);
	assert.equal(attempts, 1, "first attempt runs immediately");
	assert.equal(registry.stats().pending, 1, "entry is waiting to retry");

	await scheduler.advance(100);
	await sleep(5);
	assert.equal(attempts, 2, "retry after initial delay");

	await scheduler.advance(200);
	await sleep(5);
	assert.equal(attempts, 3, "backoff doubled");

	await scheduler.advance(400);
	await sleep(5);
	assert.equal(attempts, 4, "backoff doubled again");

	// Max attempts exceeded; entry becomes failed.
	await sleep(5);
	assert.equal(registry.stats().failed, 1);
	assert.equal(registry.stats().pending, 0);
});

test("OrphanCleanupRegistry: dispose hang is timed out and retried", async () => {
	const scheduler = new FakeScheduler();
	const registry = new OrphanCleanupRegistry(
		{
			maxEntries: 8,
			initialRetryMs: 50,
			maxRetryMs: 200,
			retryMultiplier: 1,
			maxAttempts: 3,
			cleanupTimeoutMs: 100,
		},
		scheduler,
	);

	let attempts = 0;
	const cleanup = async () => {
		attempts++;
		await scheduler.setTimer(10_000).promise; // never resolves in test time
	};

	registry.register("hang-1", cleanup);
	await sleep(5);
	assert.equal(attempts, 1, "first attempt starts immediately");

	// Each attempt times out after cleanupTimeoutMs and is retried with
	// bounded backoff. Run the clock to the terminal failure point:
	// attempt1 timeout(100) + retry(50) + attempt2 timeout(100) + retry(50) + attempt3 timeout(100) = 400.
	await scheduler.advance(400);
	await sleep(5);
	assert.equal(attempts, 3, "all three attempts were made");
	assert.equal(registry.stats().failed, 1, "entry is terminal after maxAttempts");
});

test("OrphanCleanupRegistry: exact-once cleanup", async () => {
	const scheduler = new FakeScheduler();
	const registry = new OrphanCleanupRegistry(
		{
			maxEntries: 8,
			initialRetryMs: 10,
			maxRetryMs: 100,
			retryMultiplier: 2,
			maxAttempts: 5,
			cleanupTimeoutMs: 1_000,
		},
		scheduler,
	);

	let disposed = 0;
	const cleanup = async () => {
		disposed++;
	};

	registry.register("once", cleanup);
	await sleep(5);
	assert.equal(disposed, 1);
	assert.equal(registry.stats().completed, 1);
});

test("OrphanCleanupRegistry: caps total entries and evicts oldest terminal entries", async () => {
	const scheduler = new FakeScheduler();
	const registry = new OrphanCleanupRegistry(
		{
			maxEntries: 3,
			initialRetryMs: 1,
			maxRetryMs: 10,
			retryMultiplier: 1,
			maxAttempts: 1,
			cleanupTimeoutMs: 1_000,
		},
		scheduler,
	);

	for (let i = 0; i < 4; i++) {
		registry.register(`evict-${i}`, async () => {});
	}
	await sleep(5);

	assert.equal(registry.stats().completed, 3, "oldest completed entry is evicted to stay at maxEntries");
	assert.equal(registry.stats().evicted, 1);
	assert.ok(!registry.stats().pending, "no pending work remains");
});

test("OrphanCleanupRegistry: drain waits for active entries to complete", async () => {
	const scheduler = new FakeScheduler();
	const registry = new OrphanCleanupRegistry(
		{
			maxEntries: 8,
			initialRetryMs: 1_000,
			maxRetryMs: 1_000,
			retryMultiplier: 1,
			maxAttempts: 5,
			cleanupTimeoutMs: 5_000,
		},
		scheduler,
	);

	let cleaned = false;
	registry.register("drain-1", async () => {
		await scheduler.setTimer(100).promise;
		cleaned = true;
	});
	await sleep(5);
	// The cleanup is running but awaiting its own timer, so it is "disposing".
	assert.equal(registry.stats().disposing, 1);

	// Let the cleanup finish before calling drain.
	await scheduler.advance(100);
	await sleep(5);
	assert.equal(cleaned, true);
	assert.equal(registry.stats().completed, 1);

	// Drain should resolve immediately when there is no active work.
	await within(100, registry.drain());
});

test("OrphanCleanupRegistry: active drain uses a referenced polling timer", async () => {
	const scheduler = new FakeScheduler();
	const registry = new OrphanCleanupRegistry(
		{
			maxEntries: 8,
			initialRetryMs: 1_000,
			maxRetryMs: 1_000,
			retryMultiplier: 1,
			maxAttempts: 1,
			cleanupTimeoutMs: 5_000,
		},
		scheduler,
	);

	registry.register("drain-ref", () => scheduler.setTimer(100).promise);
	await sleep(5);
	const draining = registry.drain();
	await Promise.resolve();
	assert.equal(scheduler.referencedTimers.at(-1), true, "drain polling must retain the process during beforeExit");
	await scheduler.advance(110);
	await within(100, draining);
});

test("OrphanCleanupRegistry: stats reflect pending/disposing/completed/failed totals", async () => {
	const scheduler = new FakeScheduler();
	const registry = new OrphanCleanupRegistry(
		{
			maxEntries: 8,
			initialRetryMs: 10,
			maxRetryMs: 100,
			retryMultiplier: 2,
			maxAttempts: 2,
			cleanupTimeoutMs: 1_000,
		},
		scheduler,
	);

	registry.register("ok", async () => {});
	registry.register("fail", async () => { throw new Error("no"); });

	await sleep(5);
	let stats = registry.stats();
	assert.equal(stats.totalRegistered, 2);
	assert.equal(stats.completed, 1);
	assert.equal(stats.pending, 1, "failing entry is scheduled for its first retry");
	assert.equal(stats.failed, 0);
	assert.equal(stats.disposing, 0);

	// One retry on fail before terminal.
	await scheduler.advance(10);
	await sleep(5);
	stats = registry.stats();
	assert.equal(stats.failed, 1);
	assert.equal(stats.completed, 1);
	assert.equal(stats.pending, 0);
});

// ---------------------------------------------------------------------------
// Runner integration tests
// ---------------------------------------------------------------------------

test("runSingleAgent: late createSession resolution after abort disposes the orphan once, never reaches setup/prompt, and releases capacity one", async () => {
	process.env[INFLIGHT_ENV] = "1";
	const late = createLateCreateSdk();
	const controller = new AbortController();
	const resultP = runSingleAgent(
		process.cwd(), [makeAgent()], "worker", "do work",
		undefined, undefined, controller.signal, undefined, makeDetails(),
		makeModelRegistry(), undefined,
		{ modelId: "model-a", bucket: "medium", thinkingLevel: "low", pool: ["model-a"], fallback: false },
		undefined, undefined, undefined, undefined, undefined,
		{ sdk: late.sdk as any, timeoutMs: 0 },
	);

	// Wait for createSession to be entered, then abort before it resolves.
	while (late.state.createSessionCalls === 0) await sleep(1);
	controller.abort();
	const result = await within(1500, resultP);
	assert.equal(result.exitCode, 1);
	assert.equal(result.stopReason, "aborted");

	// Now resolve the creation promise late. The orphan cleanup must dispose it
	// without ever setting UI context, subscribing, or prompting.
	late.resolveCreate();
	await sleep(20);
	assert.equal(late.state.disposeCalls, 1, "late session disposed exactly once");
	assert.equal(late.state.setUIContextCalls, 0, "orphan never reaches setUIContext");
	assert.equal(late.state.subscribeCalls, 0, "orphan never reaches subscribe");
	assert.equal(late.state.promptCalls, 0, "orphan never reaches prompt");

	// The permit was released at local settlement; a follow-up root can run.
	const fast = createFastSdk();
	const followUp = await within(1500, runSingleAgent(
		process.cwd(), [makeAgent()], "worker", "do work",
		undefined, undefined, undefined, undefined, makeDetails(),
		makeModelRegistry(), undefined,
		{ modelId: "model-a", bucket: "medium", thinkingLevel: "low", pool: ["model-a"], fallback: false },
		undefined, undefined, undefined, undefined, undefined,
		{ sdk: fast.sdk as any, timeoutMs: 0 },
	));
	assert.equal(followUp.exitCode, 0);
	assert.equal(fast.state.createSessionCalls, 1);
});

test("runSingleAgent: a dispose-failing orphan retries bounded times and still reclaims listeners", async () => {
	process.env[INFLIGHT_ENV] = "1";
	const scheduler = new FakeScheduler();
	const registry = new OrphanCleanupRegistry(
		{
			maxEntries: 8,
			initialRetryMs: 10,
			maxRetryMs: 50,
			retryMultiplier: 1,
			maxAttempts: 3,
			cleanupTimeoutMs: 20,
		},
		scheduler,
	);

	let disposeCalls = 0;
	const late = createLateCreateSdk(() => {
		disposeCalls++;
		throw new Error("dispose failure simulated");
	});

	const controller = new AbortController();
	const resultP = runSingleAgent(
		process.cwd(), [makeAgent()], "worker", "do work",
		undefined, undefined, controller.signal, undefined, makeDetails(),
		makeModelRegistry(), undefined,
		{ modelId: "model-a", bucket: "medium", thinkingLevel: "low", pool: ["model-a"], fallback: false },
		undefined, undefined, undefined, undefined, undefined,
		{ sdk: late.sdk as any, timeoutMs: 0, orphanRegistry: registry },
	);

	while (late.state.createSessionCalls === 0) await sleep(1);
	controller.abort();
	const result = await within(1500, resultP);
	assert.equal(result.exitCode, 1);

	// Resolve late; the runner attempts dispose, propagates the failure, and
	// retries up to maxAttempts. Listeners are reclaimed after each attempt.
	late.resolveCreate();
	// Advance through the retry delays so all attempts run.
	await scheduler.advance(100);
	await sleep(5);
	assert.equal(disposeCalls, 3, "dispose is retried up to maxAttempts");
	assert.equal(late.state.setUIContextCalls, 0, "orphan never reaches setUIContext");
	assert.equal(late.state.subscribeCalls, 0, "orphan never reaches subscribe");
	assert.equal(late.state.promptCalls, 0, "orphan never reaches prompt");
	assert.equal(registry.stats().failed, 1, "orphan cleanup is terminal failed");
	assert.equal(registry.stats().completed, 0, "a dispose-throw is not recorded as completed");
});

test("runSingleAgent: orphan cleanup is routed through a test registry with observable stats", async () => {
	process.env[INFLIGHT_ENV] = "1";
	const scheduler = new FakeScheduler();
	const registry = new OrphanCleanupRegistry(
		{
			maxEntries: 8,
			initialRetryMs: 1,
			maxRetryMs: 10,
			retryMultiplier: 1,
			maxAttempts: 5,
			cleanupTimeoutMs: 1_000,
		},
		scheduler,
	);
	const late = createLateCreateSdk();

	const controller = new AbortController();
	const resultP = runSingleAgent(
		process.cwd(), [makeAgent()], "worker", "do work",
		undefined, undefined, controller.signal, undefined, makeDetails(),
		makeModelRegistry(), undefined,
		{ modelId: "model-a", bucket: "medium", thinkingLevel: "low", pool: ["model-a"], fallback: false },
		undefined, undefined, undefined, undefined, undefined,
		{ sdk: late.sdk as any, timeoutMs: 0, orphanRegistry: registry },
	);

	while (late.state.createSessionCalls === 0) await sleep(1);
	controller.abort();
	const result = await within(1500, resultP);
	assert.equal(result.exitCode, 1);

	// Registry should now have one pending entry.
	let stats = registry.stats();
	assert.equal(stats.totalRegistered, 1);

	// Resolve late; the registry cleans it on its next scheduler tick.
	late.resolveCreate();
	await scheduler.advance(1);
	await sleep(5);
	stats = registry.stats();
	assert.equal(stats.completed, 1);
	assert.equal(late.state.disposeCalls, 1);
});

// ---------------------------------------------------------------------------
// REM-02 regression tests
// ---------------------------------------------------------------------------

test("OrphanCleanupRegistry: successful cleanup cancels its timeout timer", async () => {
	const scheduler = new FakeScheduler();
	const registry = new OrphanCleanupRegistry(
		{
			maxEntries: 8,
			initialRetryMs: 1,
			maxRetryMs: 10,
			retryMultiplier: 1,
			maxAttempts: 5,
			cleanupTimeoutMs: 1_000,
		},
		scheduler,
	);

	registry.register("fast", async () => {});
	await sleep(5);
	assert.equal(registry.stats().completed, 1);
	// After a successful cleanup, the timeout timer should have been cancelled;
	// no pending timers remain in the fake scheduler.
	assert.equal(scheduler["timers"].length, 0, "cleanup timeout timer must be cancelled after success");
});

test("runSingleAgent: orphan dispose is claimed exactly-once across timed-out cleanup retries", async () => {
	process.env[INFLIGHT_ENV] = "1";
	const scheduler = new FakeScheduler();
	const registry = new OrphanCleanupRegistry(
		{
			maxEntries: 8,
			initialRetryMs: 10,
			maxRetryMs: 50,
			retryMultiplier: 1,
			maxAttempts: 3,
			cleanupTimeoutMs: 20,
		},
		scheduler,
	);

	let disposeCalls = 0;
	let resolveCreate: (() => void) | undefined;
	const createPromise = new Promise<void>((r) => {
		resolveCreate = r;
	});
	const late = createLateCreateSdk(() => {
		disposeCalls++;
	});
	// Replace the create promise so we control when it resolves.
	(late.sdk as any).createSession = async () => {
		late.state.createSessionCalls++;
		await createPromise;
		return { session: {
			agent: { state: { model: { id: "session-model" } } },
			extensionRunner: { setUIContext: () => { late.state.setUIContextCalls++; throw new Error("must not reach"); } },
			subscribe: () => { late.state.subscribeCalls++; throw new Error("must not reach"); },
			prompt: async () => { late.state.promptCalls++; throw new Error("must not reach"); },
			abort: async () => {},
			dispose: () => { disposeCalls++; },
		} };
	};

	const controller = new AbortController();
	const resultP = runSingleAgent(
		process.cwd(), [makeAgent()], "worker", "do work",
		undefined, undefined, controller.signal, undefined, makeDetails(),
		makeModelRegistry(), undefined,
		{ modelId: "model-a", bucket: "medium", thinkingLevel: "low", pool: ["model-a"], fallback: false },
		undefined, undefined, undefined, undefined, undefined,
		{ sdk: late.sdk as any, timeoutMs: 0, orphanRegistry: registry },
	);

	while (late.state.createSessionCalls === 0) await sleep(1);
	controller.abort();
	const result = await within(1500, resultP);
	assert.equal(result.exitCode, 1);

	// Let the first two cleanup attempts time out (each cleanupTimeoutMs=20,
	// then retry delay 10). The late create promise has not resolved, so each
	// attempt awaits it and times out. Only the first claim should hold the
	// dispose work; later retries must not duplicate it.
	await scheduler.advance(60);
	assert.equal(disposeCalls, 0, "dispose cannot run before create resolves");

	// Now resolve the create promise. The single claimed attempt disposes once.
	resolveCreate?.();
	await sleep(5);
	assert.equal(disposeCalls, 1, "dispose runs exactly once even after timed-out retries");
});
