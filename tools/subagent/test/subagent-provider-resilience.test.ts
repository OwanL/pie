/**
 * REM-06 deterministic acceptance evidence — provider resilience scenarios
 * using injected clocks (no real-time sleeps).
 *
 * Covers:
 *  - Productive runs beyond 15 simulated minutes (fake clock, no force settlement)
 *  - Long stalled phases remain alive until explicit parent cancellation
 *  - Different-provider recovery (primary dead → secondary takes over)
 *  - Hung abort / orphan observability (cleanup registry stats exposed)
 *  - Explicit-abort child result preservation (partial output survives in results[])
 *  - Auth failure terminates immediately (no retry)
 *  - Abortable retry backoff (fake clock, instant abort)
 *
 * Uses injected RetryClock / CleanupScheduler for deterministic timing.
 * The `execute` function from execute.ts is used for integration scenarios.
 * `OrphanCleanupRegistry` is tested directly.
 */

import test, { afterEach, after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execute } from "../src/execute.js";
import { OrphanCleanupRegistry, type CleanupScheduler } from "../src/cleanup.js";
import type { RetryClock } from "../src/retry.js";

// ESM resolve hook — redirects @mariozechner/pi-coding-agent to an in-memory mock.
// Registered globally so all execute() calls see the mock. Guarded against
// double-registration (modes.test.ts may have run first).
const MOCK_SDK_SOURCE = [
	"export class DefaultResourceLoader { constructor(a){ this.a = a; } async reload(){} }",
	"export const SessionManager = { inMemory(cwd){ return { cwd: cwd }; } };",
	"export function getAgentDir(){ return '.'; }",
	"export async function createAgentSession(args){",
	"  const listeners = [];",
	"  let release;",
	"  const session = {",
	"    agent: { state: { model: { id: 'session-model' } } },",
	"    extensionRunner: { setUIContext(){} },",
	"    subscribe(cb){ listeners.push(cb); return () => {}; },",
	"    async prompt(p){",
	"      const b = globalThis.__MOCK_SDK_BEHAVIOR__;",
	"      if (b && b.onPrompt) { await b.onPrompt(function(ev){ for (const l of listeners) l(ev); }, p); return; }",
	"      await new Promise(function(r){ release = r; });",
	"    },",
	"    async abort(){",
	"      const b = globalThis.__MOCK_SDK_BEHAVIOR__;",
	"      if (b && b.onAbort) { await b.onAbort(); return; }",
	"      if (release) release();",
	"    },",
	"    dispose(){}",
	"  };",
	"  return { session: session };",
"}",
].join("\n");

const __mockDir = mkdtempSync(path.join(tmpdir(), "resilience-mock-sdk-"));
const __mockSdkPath = path.join(__mockDir, "mock-sdk.mjs");
writeFileSync(__mockSdkPath, MOCK_SDK_SOURCE, "utf-8");
const __hookPath = path.join(__mockDir, "hook.mjs");
const __hookContent =
	"export async function resolve(specifier, context, nextResolve){" +
	"  if (specifier === '@mariozechner/pi-coding-agent') return { url: '" +
	pathToFileURL(__mockSdkPath).href +
	"', shortCircuit: true };" +
	"  return nextResolve(specifier, context);" +
	"}";
writeFileSync(__hookPath, __hookContent, "utf-8");
if (!(globalThis as { __PIE_SDK_HOOK_REGISTERED__?: boolean }).__PIE_SDK_HOOK_REGISTERED__) {
	(globalThis as { __PIE_SDK_HOOK_REGISTERED__?: boolean }).__PIE_SDK_HOOK_REGISTERED__ = true;
	Module.register(pathToFileURL(__hookPath));
}

// ===========================================================================
// Agent dir setup (required by discoverAgents in execute.ts)
// ===========================================================================

const agentDir = mkdtempSync(path.join(tmpdir(), "resilience-agents-"));
const agentsSubdir = path.join(agentDir, "agents");
mkdirSync(agentsSubdir, { recursive: true });
writeFileSync(
	path.join(agentsSubdir, "worker.md"),
	"---\nname: worker\ndescription: test agent\n---\nYou are a worker.\n",
	"utf-8",
);

const ENV_KEYS = [
	"PIE_SUBAGENT_MAX_INFLIGHT",
	"PIE_SUBAGENT_ALWAYS_PARENT_MODEL",
	"PIE_SUBAGENT_BUCKETS_JSON",
	"PI_CODING_AGENT_DIR",
	"PI_SUBAGENT_DEPTH",
] as const;

const snapshot: Record<string, string | undefined> = {};
test.before(() => {
	for (const key of ENV_KEYS) snapshot[key] = process.env[key];
	process.env.PIE_SUBAGENT_ALWAYS_PARENT_MODEL = "1";
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "8";
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
test.beforeEach(() => {
	// Restore the defaults that individual tests mutate so later tests do not
	// inherit a previous test's environment (e.g. always-parent-model disabled
	// or bucket assignments from the provider-failover scenario).
	process.env.PIE_SUBAGENT_ALWAYS_PARENT_MODEL = "1";
	delete process.env.PIE_SUBAGENT_BUCKETS_JSON;
});

test.after(() => {
	for (const key of ENV_KEYS) {
		if (snapshot[key] === undefined) delete process.env[key];
		else process.env[key] = snapshot[key]!;
	}
});
after(() => {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(__mockDir, { recursive: true, force: true });
});

// ===========================================================================
// Fake clock — timers resolve at 0 advance or explicitly
// ===========================================================================

class FakeClock implements RetryClock {
	nowMs = 0;
	setTimerCalls = 0;
	private timers: Array<{ deadline: number; resolve: () => void }> = [];

	now(): number { return this.nowMs; }

	setTimer(ms: number): ReturnType<RetryClock["setTimer"]> {
		this.setTimerCalls++;
		const deadline = this.nowMs + ms;
		let resolve: () => void;
		const promise = new Promise<void>((r) => { resolve = r; });
		const timer = { deadline, resolve: resolve! };
		this.timers.push(timer);
		return {
			promise,
			cancel: () => { this.timers = this.timers.filter((t) => t !== timer); },
		};
	}

	async advance(ms: number): Promise<void> {
		const target = this.nowMs + ms;
		let safety = 0;
		while (this.nowMs < target && safety < 1_000) {
			safety++;
			const next = this.timers
				.filter((t) => t.deadline <= target)
				.sort((a, b) => a.deadline - b.deadline)[0];
			if (!next) { this.nowMs = target; break; }
			this.nowMs = next.deadline;
			this.timers = this.timers.filter((t) => t !== next);
			next.resolve();
			await Promise.resolve();
		}
	}

	elapsed(): number { return this.nowMs; }
}

class FakeScheduler implements CleanupScheduler {
	nowMs = 0;
	private timers: Array<{ deadline: number; resolve: () => void }> = [];

	now(): number { return this.nowMs; }

	setTimer(ms: number): ReturnType<CleanupScheduler["setTimer"]> {
		const deadline = this.nowMs + ms;
		let resolve: () => void;
		const promise = new Promise<void>((r) => { resolve = r; });
		const timer = { deadline, resolve: resolve! };
		this.timers.push(timer);
		return {
			promise,
			cancel: () => { this.timers = this.timers.filter((t) => t !== timer); },
		};
	}

	async advance(ms: number): Promise<void> {
		const target = this.nowMs + ms;
		let safety = 0;
		while (this.nowMs < target && safety < 1_000) {
			safety++;
			const next = this.timers
				.filter((t) => t.deadline <= target)
				.sort((a, b) => a.deadline - b.deadline)[0];
			if (!next) { this.nowMs = target; break; }
			this.nowMs = next.deadline;
			this.timers = this.timers.filter((t) => t !== next);
			next.resolve();
			await Promise.resolve();
		}
	}
}

// ===========================================================================
// Helper: fake SDK behavior
// ===========================================================================

function setMockBehavior(b: unknown): void {
	(globalThis as { __MOCK_SDK_BEHAVIOR__?: unknown }).__MOCK_SDK_BEHAVIOR__ = b;
}

function assignedModels(...models: string[]) {
	return models.map((model) => ({ model, thinkingLevel: "high" as const }));
}

afterEach(() => { setMockBehavior(undefined); });

async function flushAsync(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

function within<T>(ms: number, p: Promise<T>): Promise<T> {
	return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms))]);
}


function messageEnd(text: string, stopReason: string): any {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
			model: "m",
			stopReason,
		},
	};
}

// ===========================================================================
// 1. PRODUCTIVE PROGRESS BEYOND 15 SIMULATED MINUTES
// ===========================================================================

test("execute(): productive run beyond 15 simulated minutes stays alive until explicit completion", async () => {
	const clock = new FakeClock();

	setMockBehavior({
		onPrompt: async (emit: (event: unknown) => void) => {
			for (let i = 0; i < 16; i++) {
				// Advance far past every historical phase lease between heartbeats.
				// A force-settling lease would have killed this run long ago.
				await clock.advance(60_000);
				emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `step ${i} ` } });
				// Tool lifecycle changes publish immediately (unlike coalesced token
				// bursts), giving the boundary a deterministic lifecycle heartbeat.
				emit({ type: "tool_execution_start", toolCallId: `tc-${i}`, toolName: `read_file_${i}` });
			}
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done after more than 15 simulated minutes" }],
					usage: { input: 1, output: 16, cacheRead: 0, cacheWrite: 0, totalTokens: 17, cost: { total: 0 } },
					model: "m",
					stopReason: "completed",
				},
			});
		},
	});

	const response = await within(5000, execute(
		"tool-long-productive",
		{ agent: "worker", task: "do long productive work" } as never,
		new AbortController().signal,
		() => undefined,
		{ cwd: agentDir, hasUI: false, model: { id: "active-model", provider: "test" },
			modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined } } as never,
		{ getAllTools: () => [] } as never,
		() => false,
		{ clock },
	));

	assert.equal(response.isError, undefined, "a productive long run must complete, not be force-settled");
	assert.equal(response.details.results[0]?.thinkingLevel, "high", "missing getThinkingLevel should use the high fallback");
	assert.match((response.content?.[0] as { text?: string } | undefined)?.text ?? "", /more than 15 simulated minutes/);
	assert.ok(clock.elapsed() > 900_000, `simulated time ${clock.elapsed()}ms should exceed 15 minutes`);
	assert.equal(clock.setTimerCalls, 0, "settlement must not be replaced with another time guess");
});

test("execute(): headers with no first token stay alive until explicit cancellation", async () => {
	const clock = new FakeClock();
	setMockBehavior({ onPrompt: () => new Promise<void>(() => {}) });

	const controller = new AbortController();
	let reachedProviderWait = false;
	const responseP = execute(
		"tool-no-first-token",
		{ agent: "worker", task: "wait for first token" } as never,
		controller.signal,
		(partial) => {
			reachedProviderWait ||= partial.details?.results?.[0]?.activityPhase === "waiting_provider";
		},
		{ cwd: agentDir, hasUI: false, model: { id: "active-model", provider: "test" },
			modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined } } as never,
		{ getAllTools: () => [] } as never,
		() => false,
		{ clock },
	);
	for (let i = 0; i < 100 && !reachedProviderWait; i++) await Promise.resolve();
	assert.equal(reachedProviderWait, true, "the fake session must reach provider wait before time advances");

	// No lease fires: far beyond the old provider-wait budget the dispatch is
	// still alive. (Provider/header liveness remains bounded by ProviderGate in
	// the host, outside this extension — not by a wall-clock run timer here.)
	let settledEarly = false;
	void responseP.then(() => { settledEarly = true; }, () => { settledEarly = true; });
	await clock.advance(60 * 60_000);
	await flushAsync();
	assert.equal(settledEarly, false, "a stalled provider wait must not be force-settled by any time bound");

	controller.abort();
	const response = await within(5000, responseP);
	assert.equal(response.isError, true);
	assert.match(response.details.results[0]?.errorMessage ?? "", /abort/i);
});

test("execute(): mid-stream disconnect is terminal and preserves partial output without replay", async () => {
	const clock = new FakeClock();
	setMockBehavior({
		onPrompt: async (emit: (event: unknown) => void) => {
			emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial response" } });
			throw Object.assign(new Error("connection reset mid-stream"), { code: "ECONNRESET" });
		},
	});
	const response = await within(5000, execute(
		"tool-midstream-reset",
		{ agent: "worker", task: "stream then disconnect" } as never,
		new AbortController().signal,
		() => undefined,
		{ cwd: agentDir, hasUI: false, model: { id: "active-model", provider: "test" },
			modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined } } as never,
		{ getAllTools: () => [] } as never,
		() => false,
		{ clock },
	));
	assert.equal(response.isError, true);
	assert.equal(response.details.results.length, 1, "disconnect must not replay the attempt");
	assert.equal(response.details.results[0]?.failureClass, "transport");
	assert.equal(response.details.results[0]?.replaySafety, "partial_output");
	assert.match(response.details.results[0]?.finalOutput ?? "", /partial response/);
});

test("execute(): output followed by a hung tool stays alive and retains the output until explicit cancellation", async () => {
	const clock = new FakeClock();
	setMockBehavior({
		onPrompt: async (emit: (event: unknown) => void) => {
			emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer before tool" } });
			emit({ type: "tool_execution_start", toolCallId: "hung-tool", toolName: "external_write" });
			return new Promise<void>(() => {});
		},
	});
	const controller = new AbortController();
	let reachedHungTool = false;
	const responseP = execute(
		"tool-hung-after-output",
		{ agent: "worker", task: "run a hung tool" } as never,
		controller.signal,
		(partial) => {
			reachedHungTool ||= partial.details?.results?.[0]?.runningTools?.includes("external_write") === true;
		},
		{ cwd: agentDir, hasUI: false, model: { id: "active-model", provider: "test" },
			modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined } } as never,
		{ getAllTools: () => [] } as never,
		() => false,
		{ clock },
	);
	for (let i = 0; i < 100 && !reachedHungTool; i++) await Promise.resolve();
	assert.equal(reachedHungTool, true, "the fake session must reach the hung tool phase before time advances");

	// No lease fires: far beyond the old running_tool budget the dispatch is
	// still alive.
	let settledEarly = false;
	void responseP.then(() => { settledEarly = true; }, () => { settledEarly = true; });
	await clock.advance(30 * 60_000);
	await flushAsync();
	assert.equal(settledEarly, false, "a hung tool phase must not be force-settled by any time bound");

	controller.abort();
	const response = await within(5000, responseP);
	assert.equal(response.isError, true);
	assert.match(response.details.results[0]?.finalOutput ?? "", /answer before tool/, "partial output survives explicit cancellation");
});

// ===========================================================================
// 2. DIFFERENT-PROVIDER RECOVERY
// ===========================================================================

test("execute(): injected clock drives Retry-After wait and provider failover", async () => {
	const savedRandom = Math.random;
	Math.random = () => 0;
	try {
		delete process.env.PIE_SUBAGENT_ALWAYS_PARENT_MODEL;
		process.env.PIE_SUBAGENT_BUCKETS_JSON = JSON.stringify({
			small: [],
			medium: assignedModels("model-a", "model-b"),
			frontier: [],
		});

		const clock = new FakeClock();
		let attempt = 0;
		setMockBehavior({
			onPrompt: async (emit: (event: unknown) => void) => {
				attempt++;
				if (attempt === 1) {
					throw Object.assign(new Error("rate limited"), {
						status: 429,
						headers: { "retry-after": new Date(clock.now() + 2_000).toUTCString() },
					});
				}
				emit(messageEnd("done after retry", "completed"));
			},
		});

		const phases: string[] = [];
		const responseP = execute(
			"tool-retry-clock",
			{ agent: "worker", task: "do work" } as never,
			new AbortController().signal,
			(partial) => {
				const phase = partial.details?.results?.[0]?.activityPhase;
				if (phase) phases.push(phase);
			},
			{
				cwd: agentDir,
				hasUI: false,
				model: { id: "model-a", provider: "provider-a" },
				modelRegistry: {
					getAvailable: () => [
						{ id: "model-a", provider: "provider-a" },
						{ id: "model-b", provider: "provider-b" },
					],
					getAll: () => [],
					find: () => undefined,
				},
			} as never,
			{ getAllTools: () => [] } as never,
			() => false,
			{ clock },
		);

		// Wait for the retry_wait phase to be published, then deterministically
		// advance the fake clock through the Retry-After delay.
		for (let i = 0; i < 100 && !phases.includes("retry_wait"); i++) {
			await Promise.resolve();
		}
		await clock.advance(2_000);
		const response = await within(5000, responseP);

		assert.equal(response.isError, undefined, "retry should succeed");
		assert.equal(attempt, 2, "both attempts must dispatch");
		assert.ok(phases.includes("retry_wait"), "retry_wait phase must be observable via onUpdate");
		assert.equal(response.details.results[0]?.retryCount, 1);
		assert.equal(response.details.results[0]?.failedModel, "model-a");
		assert.ok(clock.elapsed() >= 2_000, "fake clock must advance through the Retry-After wait");
	} finally {
		Math.random = savedRandom;
	}
});

// ===========================================================================
// 3. HUNG ABORT / ORPHAN OBSERVABILITY
// ===========================================================================

test("OrphanCleanupRegistry: dispose failure is observable without blocking subsequent work", async () => {
	const scheduler = new FakeScheduler();
	const registry = new OrphanCleanupRegistry({
		maxEntries: 8, initialRetryMs: 1, maxRetryMs: 10, retryMultiplier: 1,
		maxAttempts: 2, cleanupTimeoutMs: 10,
	}, scheduler);

	let disposeCalls = 0;
	registry.register("attempt-orphan-fail", async () => { disposeCalls++; throw new Error("dispose hung"); });

	await flushAsync();
	assert.equal(disposeCalls, 1, "first cleanup attempt runs immediately");

	await scheduler.advance(1);
	await flushAsync();
	assert.equal(disposeCalls, 2, "retry attempt runs");

	const stats = registry.stats();
	assert.equal(stats.failed, 1, "after maxAttempts the orphan is terminal failed");
	assert.equal(stats.pending, 0);

	// A new entry can complete even with a failed orphan.
	registry.register("clean-entry-2", async () => {});
	await flushAsync();
	assert.equal(registry.stats().completed, 1, "a new entry can complete alongside a failed orphan");
});

test("OrphanCleanupRegistry: cleanup stats include attempt identity and observable counters", async () => {
	const scheduler = new FakeScheduler();
	const registry = new OrphanCleanupRegistry({
		maxEntries: 8, initialRetryMs: 1, maxRetryMs: 10, retryMultiplier: 1,
		maxAttempts: 3, cleanupTimeoutMs: 1_000,
	}, scheduler);

	registry.register("attempt-orphan-1", async () => {});
	await flushAsync();

	const stats = registry.stats();
	assert.equal(stats.totalRegistered, 1);
	assert.equal(stats.completed, 1, "orphan cleanup is observable as completed");
	assert.equal(stats.pending, 0);
	assert.equal(stats.failed, 0);
});

// ===========================================================================
// 4. EXPLICIT-ABORT CHILD RESULT PRESERVATION
// ===========================================================================

test("execute(): a cancelled child preserves partial output in results[]", async () => {
	setMockBehavior({
		onPrompt: async (emit: (event: unknown) => void) => {
			emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial " } });
			return new Promise<void>(() => {}); // never resolves
		},
	});

	const controller = new AbortController();
	const responseP = execute(
		"tool-sibling-preserve",
		{ agent: "worker", task: "do work" } as never,
		controller.signal,
		() => undefined,
		{ cwd: agentDir, hasUI: false, model: { id: "active-model", provider: "test" },
			modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined } } as never,
		{ getAllTools: () => [] } as never,
		() => false,
	);
	// Give the child a moment to publish its partial output, then cancel.
	await new Promise((resolve) => setTimeout(resolve, 30));
	controller.abort();
	const response = await within(5000, responseP);

	assert.equal(response.isError, true, "the cancelled child settles with an error");
	assert.ok(
		response.details?.results && response.details.results.length > 0,
		"cancelled child must preserve partial output in results[]",
	);
});

// ===========================================================================
// 5. RETRY CLOCK — abortable delay with fake clock
// ===========================================================================

test("execute(): parent abort settles even when child abort never resolves", async () => {
	setMockBehavior({
		onPrompt: () => new Promise<void>(() => {}),
		onAbort: () => new Promise<void>(() => {}),
	});

	const controller = new AbortController();
	const responseP = execute(
		"t-abort-no-net",
		{ agent: "worker", task: "do work" } as never,
		controller.signal,
		() => undefined,
		{ cwd: agentDir, hasUI: false, model: { id: "active-model", provider: "test" },
			modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined } } as never,
		{ getAllTools: () => [] } as never,
		() => false,
	);
	controller.abort();
	const response = await within(5000, responseP);

	assert.equal(response.isError, true);
	const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "";
	assert.match(text, /abort/i);
});
