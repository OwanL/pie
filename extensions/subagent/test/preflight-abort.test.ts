/**
 * Structural hardening tests: the parent abort signal MUST interrupt every
 * pre-spawn phase (resource load, concurrency acquire, session creation), and a
 * hung pre-spawn phase MUST NOT leak the concurrency permit (which would
 * permanently disable subagents process-wide).
 *
 * These reproduce the "Build Out" freeze class: a worker that never spawned a
 * session file because it was stuck pre-spawn, with Stop doing nothing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Semaphore } from "../src/concurrency-limit.js";
import { runSingleAgent } from "../runner.js";
import type { AgentConfig } from "../agents.js";

// ---- helpers (mirror execution-paths.test.ts shapes) ------------------------

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

/** A fake SDK where `createSession` NEVER resolves (the Build Out pre-spawn hang). */
function createHangingCreateSessionSdk() {
	const state = { createSessionEntered: 0, reloadCalls: 0, abortCalls: 0, disposeCalls: 0 };
	const listeners: Array<(e: any) => void> = [];
	const session = {
		agent: { state: { model: { id: "session-model" } } },
		extensionRunner: { setUIContext: () => {} },
		subscribe: (cb: any) => { listeners.push(cb); return () => {}; },
		prompt: async () => { state; /* never reached */ },
		abort: async () => { state.abortCalls++; },
		dispose: () => { state.disposeCalls++; },
	};
	const createSessionPromise = new Promise(() => {}); // never settles
	const sdk = {
		createSession: async () => { state.createSessionEntered++; await createSessionPromise; return { session }; },
		createResourceLoader: () => ({ reload: async () => { state.reloadCalls++; } }),
		createSessionManager: () => ({}),
		getAgentDir: () => ".",
	};
	return { sdk, state };
}

/** A fake SDK where `reload` NEVER resolves (pre-spawn hang before the permit). */
function createHangingReloadSdk() {
	const state = { reloadEntered: 0, createSessionCalls: 0, disposeCalls: 0 };
	const session = {
		agent: { state: { model: { id: "session-model" } } },
		extensionRunner: { setUIContext: () => {} },
		subscribe: () => () => {},
		prompt: async () => {},
		abort: async () => {},
		dispose: () => { state.disposeCalls++; },
	};
	const reloadPromise = new Promise(() => {});
	const sdk = {
		createSession: async () => { state.createSessionCalls++; return { session }; },
		createResourceLoader: () => ({ reload: async () => { state.reloadEntered++; await reloadPromise; } }),
		createSessionManager: () => ({}),
		getAgentDir: () => ".",
	};
	return { sdk, state };
}

/** A fast, fully-controllable SDK for the "no poison leak" follow-up call. */
function createFastSdk(events: any[] = []) {
	const listeners: Array<(e: any) => void> = [];
	const session = {
		agent: { state: { model: { id: "session-model" } } },
		extensionRunner: { setUIContext: () => {} },
		subscribe: (cb: any) => { listeners.push(cb); return () => {}; },
		prompt: async () => { for (const e of events) for (const l of listeners) l(e); },
		abort: async () => {},
		dispose: () => {},
	};
	return {
		sdk: {
			createSession: async () => ({ session }),
			createResourceLoader: () => ({ reload: async () => {} }),
			createSessionManager: () => ({}),
			getAgentDir: () => ".",
		},
	};
}

/** Reject if the promise hasn't settled within `ms` — proves "returns promptly". */
function within<T>(ms: number, p: Promise<T>): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms)),
	]);
}

// ---- env save/restore for the inflight cap ----------------------------------

const INFLIGHT_ENV = "PIE_SUBAGENT_MAX_INFLIGHT";
let savedInflight: string | undefined;

test.before(() => { savedInflight = process.env[INFLIGHT_ENV]; });
test.after(() => {
	if (savedInflight === undefined) delete process.env[INFLIGHT_ENV];
	else process.env[INFLIGHT_ENV] = savedInflight;
});

// =============================================================================
// Semaphore: abortable acquire (permit-safety root cause)
// =============================================================================

test("Semaphore.acquire: already-aborted signal rejects immediately without acquiring a permit", async () => {
	const sem = new Semaphore(() => 1);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => sem.acquire(controller.signal), /abort/i);
	// No permit consumed → a plain acquire still resolves immediately.
	const release = await sem.acquire();
	release();
});

test("Semaphore.acquire: signal aborting while queued rejects, removes the waiter, and does NOT leak a permit", async () => {
	const sem = new Semaphore(() => 1);
	const hold = await sem.acquire(); // exhaust capacity
	const controller = new AbortController();
	let rejected = false;
	// `pending` is the raw acquire promise so we can assert it rejects. A
	// separate `.catch` flips `rejected` so the "still queued" check below can
	// read it without unhandled-rejection noise.
	const pending = sem.acquire(controller.signal);
	pending.catch(() => { rejected = true; });
	await new Promise((r) => setTimeout(r, 5));
	assert.equal(rejected, false); // still queued
	controller.abort();
	await assert.rejects(() => pending, /abort/i);
	// Waiter removed: releasing the held permit must NOT hand it to the aborted waiter
	// (which would double-resolve / leak). A fresh acquire must get the permit.
	hold();
	const release2 = await sem.acquire();
	release2();
});

// =============================================================================
// runSingleAgent: abort propagates to every pre-spawn phase
// =============================================================================

test("runSingleAgent: aborting DURING createSession (never resolves) returns promptly with an abort error, not a hang", async () => {
	const { sdk, state } = createHangingCreateSessionSdk();
	const controller = new AbortController();
	const resultP = runSingleAgent(
		process.cwd(), [makeAgent()], "worker", "do work",
		undefined, undefined, controller.signal, undefined, makeDetails(),
		makeModelRegistry(), undefined,
		{ modelId: "model-a", bucket: "medium", thinkingLevel: "low", pool: ["model-a"], fallback: false },
		undefined, undefined, undefined, undefined, undefined,
		{ sdk: sdk as any, timeoutMs: 0 },
	);
	// Let createSession be entered & pending.
	await new Promise((r) => setTimeout(r, 10));
	controller.abort();
	const result = await within(1500, resultP);
	assert.equal(result.exitCode, 1);
	assert.match(result.errorMessage ?? "", /abort|preparing|creating/i);
	assert.equal(state.createSessionEntered, 1);
});

test("runSingleAgent: aborting DURING resource reload (never resolves) returns promptly with an abort error", async () => {
	const { sdk, state } = createHangingReloadSdk();
	const controller = new AbortController();
	const resultP = runSingleAgent(
		process.cwd(), [makeAgent()], "worker", "do work",
		undefined, undefined, controller.signal, undefined, makeDetails(),
		makeModelRegistry(), undefined,
		{ modelId: "model-a", bucket: "medium", thinkingLevel: "low", pool: ["model-a"], fallback: false },
		undefined, undefined, undefined, undefined, undefined,
		{ sdk: sdk as any, timeoutMs: 0 },
	);
	await new Promise((r) => setTimeout(r, 10));
	controller.abort();
	const result = await within(1500, resultP);
	assert.equal(result.exitCode, 1);
	assert.match(result.errorMessage ?? "", /abort|preparing|loading/i);
	assert.equal(state.reloadEntered, 1);
});

test("runSingleAgent: a createSession hang does NOT poison the process-wide semaphore — a follow-up call still acquires (no leaked permit)", async () => {
	// Force capacity 1 so a leaked permit would deadlock the next call.
	process.env[INFLIGHT_ENV] = "1";
	const { sdk } = createHangingCreateSessionSdk();
	const controller = new AbortController();
	const hungP = runSingleAgent(
		process.cwd(), [makeAgent()], "worker", "do work",
		undefined, undefined, controller.signal, undefined, makeDetails(),
		makeModelRegistry(), undefined,
		{ modelId: "model-a", bucket: "medium", thinkingLevel: "low", pool: ["model-a"], fallback: false },
		undefined, undefined, undefined, undefined, undefined,
		{ sdk: sdk as any, timeoutMs: 0 },
	);
	await new Promise((r) => setTimeout(r, 10));
	controller.abort();
	await within(1500, hungP); // must settle (permit released in finally)

	// Follow-up with a fast SDK + a real assistant message_end → must complete.
	const fast = createFastSdk([{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cost: { total: 0 } } } }]);
	const result = await within(1500, runSingleAgent(
		process.cwd(), [makeAgent()], "worker", "do work",
		undefined, undefined, undefined, undefined, makeDetails(),
		makeModelRegistry(), undefined,
		{ modelId: "model-a", bucket: "medium", thinkingLevel: "low", pool: ["model-a"], fallback: false },
		undefined, undefined, undefined, undefined, undefined,
		{ sdk: fast.sdk as any, timeoutMs: 0 },
	));
	assert.equal(result.exitCode, 0);
});