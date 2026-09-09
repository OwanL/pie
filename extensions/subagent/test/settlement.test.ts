/**
 * Execute-boundary liveness tests (no force settlement): `execute()` must NOT
 * force-settle a child after any elapsed-inactivity or absolute-duration
 * bound. A healthy child stays alive through long queued/preparing/streaming/
 * tool/retry phases until it completes explicitly or the parent/user cancels.
 * Stalled cleanup remains bounded elsewhere (orphan registry, already-aborted
 * bounded races); none of that may masquerade as a wall-clock run timer.
 *
 * Approach: register an ESM resolve hook (same technique as modes.test.ts) that
 * redirects `@mariozechner/pi-coding-agent` to an in-memory mock whose
 * `prompt`/`reload`/`createSession` read `globalThis.__MOCK_SDK_BEHAVIOR__`.
 * A never-resolving `onPrompt` simulates a dead provider stream / hung SDK
 * that ignores abort — the case that used to rely on the removed settlement
 * net and now is resolved only by explicit cancellation. Kept self-contained
 * (own mock + hook) but idempotent: a global guard prevents double-registration
 * if modes.test.ts already installed a hook in the same process.
 */

import test, { afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import Module from "node:module";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execute } from "../src/execute.js";
import { inflightSemaphore } from "../src/concurrency-limit.js";
import type { RetryClock } from "../src/retry.js";

// ---------------------------------------------------------------------------
// In-memory mock SDK + ESM resolve hook (redirect @mariozechner/pi-coding-agent)
// ---------------------------------------------------------------------------

const MOCK_SDK_SOURCE = [
	"export class DefaultResourceLoader { constructor(a){ this.a = a; } async reload(){ const b = globalThis.__MOCK_SDK_BEHAVIOR__; if (b && b.onReload) { await b.onReload(); return; } } }",
	"export const SessionManager = { inMemory(cwd){ return { cwd: cwd }; } };",
	"export function getAgentDir(){ return '.'; }",
	"export async function createAgentSession(args){",
	"  const listeners = [];",
	"  let release;",
	"  const setup = globalThis.__MOCK_SDK_BEHAVIOR__;",
	"  if (setup && setup.onCreateSession) { await setup.onCreateSession(); }",
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

const mockDir = mkdtempSync(path.join(tmpdir(), "settlement-mock-sdk-"));
const mockSdkPath = path.join(mockDir, "mock-sdk.mjs");
writeFileSync(mockSdkPath, MOCK_SDK_SOURCE, "utf-8");
const hookPath = path.join(mockDir, "hook.mjs");
writeFileSync(
	hookPath,
	[
		"export async function resolve(specifier, context, nextResolve){",
		`  if (specifier === '@mariozechner/pi-coding-agent') return { url: ${JSON.stringify(pathToFileURL(mockSdkPath).href)}, shortCircuit: true };`,
		"  return nextResolve(specifier, context);",
		"}",
	].join("\n"),
	"utf-8",
);
// Guard against double-registration when modes.test.ts loads in the same tsx
// process (the repo runner globs all subagent test files into one `tsx --test`).
if (!(globalThis as { __PIE_SDK_HOOK_REGISTERED__?: boolean }).__PIE_SDK_HOOK_REGISTERED__) {
	(globalThis as { __PIE_SDK_HOOK_REGISTERED__?: boolean }).__PIE_SDK_HOOK_REGISTERED__ = true;
	Module.register(pathToFileURL(hookPath));
}

// ---------------------------------------------------------------------------
// Fake clock — timers resolve at 0 advance or explicitly (retry backoff seam).
// Records every setTimer call so tests can prove NO settlement timer is armed.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test fixtures: a temp agent dir so discoverAgents(scope:"user") finds "worker"
// ---------------------------------------------------------------------------

const agentDir = mkdtempSync(path.join(tmpdir(), "settlement-agents-"));
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
	"PI_CODING_AGENT_DIR",
	"PI_SUBAGENT_DEPTH",
] as const;

const snapshot: Record<string, string | undefined> = {};
test.before(() => {
	for (const key of ENV_KEYS) snapshot[key] = process.env[key];
	// Force the mock SDK to always-parent-model (pure selection, no analytics)
	// and a generous inflight cap so the permit never blocks unless a test
	// deliberately saturates it (the queued-phase scenario).
	process.env.PIE_SUBAGENT_ALWAYS_PARENT_MODEL = "1";
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "8";
	delete process.env.PI_SUBAGENT_DEPTH;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

test.after(() => {
	for (const key of ENV_KEYS) {
		if (snapshot[key] === undefined) delete process.env[key];
		else process.env[key] = snapshot[key]!;
	}
});

after(() => {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(mockDir, { recursive: true, force: true });
});

function setMockBehavior(b: unknown): void {
	(globalThis as { __MOCK_SDK_BEHAVIOR__?: unknown }).__MOCK_SDK_BEHAVIOR__ = b;
}
afterEach(() => {
	setMockBehavior(undefined);
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "8";
});

function makeCtx(): unknown {
	return {
		cwd: agentDir,
		hasUI: false,
		model: { id: "active-model", provider: "test" },
		modelRegistry: {
			getAvailable: () => [{ id: "active-model", provider: "test" }],
			getAll: () => [{ id: "active-model", provider: "test" }],
			find: (_provider: string, id: string) =>
				id === "active-model" ? { id: "active-model", provider: "test" } : undefined,
		},
	};
}

/** Reject if the promise hasn't settled within `ms` — proves "returns in time". */
function within<T>(ms: number, p: Promise<T>): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms),
		),
	]);
}

async function flushAsync(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

function messageEnd(text: string, stopReason: string): unknown {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("execute(): a silent hung dispatch is NOT force-settled — explicit parent cancellation owns settlement", async () => {
	const clock = new FakeClock();
	setMockBehavior({ onPrompt: () => new Promise<void>(() => {}) });

	const controller = new AbortController();
	let observedWaitingProvider = false;
	const responseP = execute(
		"tool-liveness-silent",
		{ agent: "worker", task: "do work" } as never,
		controller.signal,
		(partial) => {
			observedWaitingProvider ||= partial.details?.results?.[0]?.activityPhase === "waiting_provider";
		},
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
		{ clock },
	);
	// Let the dispatch reach the provider-wait phase before time advances.
	for (let i = 0; i < 200 && !observedWaitingProvider; i++) await Promise.resolve();
	assert.equal(observedWaitingProvider, true, "the child must reach provider wait before time advances");

	// No lease exists to fire: far beyond every historical phase budget the run
	// is still alive. (The clock has no timers to advance — this proves the
	// old inactivity net is gone and nothing replaced it.)
	let settledEarly = false;
	void responseP.then(() => { settledEarly = true; }, () => { settledEarly = true; });
	await clock.advance(60 * 60_000); // one simulated hour
	await flushAsync();
	assert.equal(settledEarly, false, "a silent dispatch must not be force-settled by any time bound");
	assert.equal(clock.setTimerCalls, 0, "no settlement timer may be armed");

	// Explicit parent cancellation is the settlement owner.
	controller.abort();
	const response = await within(5000, responseP);
	assert.equal(response.isError, true);
	const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "";
	assert.match(text, /abort/i);
	assert.equal(clock.setTimerCalls, 0, "cancellation must not arm a wall-clock bound either");
});

test("execute(): a child stuck in preparing (resource load) remains alive until explicit cancellation", async () => {
	const clock = new FakeClock();
	setMockBehavior({ onReload: () => new Promise<void>(() => {}) });

	const controller = new AbortController();
	let observedPreparing = false;
	const responseP = execute(
		"tool-liveness-preparing",
		{ agent: "worker", task: "do work" } as never,
		controller.signal,
		(partial) => {
			observedPreparing ||= partial.details?.results?.[0]?.activityPhase === "preparing";
		},
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
		{ clock },
	);
	for (let i = 0; i < 200 && !observedPreparing; i++) await Promise.resolve();
	assert.equal(observedPreparing, true, "the child must publish the preparing phase");

	let settledEarly = false;
	void responseP.then(() => { settledEarly = true; }, () => { settledEarly = true; });
	await clock.advance(30 * 60_000); // far beyond the old 2-minute preparing lease
	await flushAsync();
	assert.equal(settledEarly, false, "a preparing child must not be force-settled by any time bound");

	controller.abort();
	const response = await within(5000, responseP);
	assert.equal(response.isError, true, "cancellation during pre-spawn must settle the tool call");
	const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "";
	assert.match(text, /abort/i);
});

test("execute(): a queued child behind the process permit remains alive until the slot frees", async () => {
	const clock = new FakeClock();
	const previousMaxInflight = process.env.PIE_SUBAGENT_MAX_INFLIGHT;
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "1";
	// Hold the only process permit so the child parks in the queued phase.
	const held = await inflightSemaphore.acquire();
	try {
		setMockBehavior({
			onPrompt: (emit: (event: unknown) => void) => {
				emit(messageEnd("ran after the slot freed", "completed"));
			},
		});
		const controller = new AbortController();
		let observedQueued = false;
		const responseP = execute(
			"tool-liveness-queued",
			{ agent: "worker", task: "do work" } as never,
			controller.signal,
			(partial) => {
				observedQueued ||= partial.details?.results?.[0]?.activityPhase === "queued";
			},
			makeCtx() as never,
			{ getAllTools: () => [] } as never,
			() => false,
			{ clock },
		);
		for (let i = 0; i < 200 && !observedQueued; i++) await Promise.resolve();
		assert.equal(observedQueued, true, "the child must publish the queued phase");

		let settledEarly = false;
		void responseP.then(() => { settledEarly = true; }, () => { settledEarly = true; });
		await clock.advance(60 * 60_000); // far beyond the old 10-minute queued lease
		await flushAsync();
		assert.equal(settledEarly, false, "a queued child must not be force-settled by any time bound");

		// The slot frees: the child proceeds and completes explicitly.
		held();
		const response = await within(5000, responseP);
		assert.equal(response.isError, undefined);
		assert.match((response.content?.[0] as { text?: string } | undefined)?.text ?? "", /ran after the slot freed/);
	} finally {
		held();
		if (previousMaxInflight === undefined) delete process.env.PIE_SUBAGENT_MAX_INFLIGHT;
		else process.env.PIE_SUBAGENT_MAX_INFLIGHT = previousMaxInflight;
	}
});

test("execute(): long streaming/tool phases remain alive until explicit completion (15+ simulated minutes)", async () => {
	const clock = new FakeClock();
	setMockBehavior({
		onPrompt: async (emit: (event: unknown) => void) => {
			for (let i = 0; i < 16; i++) {
				// Advance far past every historical phase lease between heartbeats.
				// A force-settling lease would have killed this run long ago.
				await clock.advance(60_000);
				emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `step ${i} ` } });
				emit({ type: "tool_execution_start", toolCallId: `tc-${i}`, toolName: `read_file_${i}` });
			}
			emit(messageEnd("done after more than 15 simulated minutes", "completed"));
		},
	});

	const response = await within(5000, execute(
		"tool-long-productive",
		{ agent: "worker", task: "do long productive work" } as never,
		new AbortController().signal,
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
		{ clock },
	));

	assert.equal(response.isError, undefined, "a productive long run must complete, not be force-settled");
	assert.match((response.content?.[0] as { text?: string } | undefined)?.text ?? "", /more than 15 simulated minutes/);
	assert.ok(clock.elapsed() > 900_000, `simulated time ${clock.elapsed()}ms should exceed 15 minutes`);
});

test("execute(): a child hung in a tool phase remains alive until explicit cancellation and retains partial output", async () => {
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
		"tool-hung-tool-liveness",
		{ agent: "worker", task: "run a hung tool" } as never,
		controller.signal,
		(partial) => {
			reachedHungTool ||= partial.details?.results?.[0]?.runningTools?.includes("external_write") === true;
		},
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
		{ clock },
	);
	for (let i = 0; i < 200 && !reachedHungTool; i++) await Promise.resolve();
	assert.equal(reachedHungTool, true, "the child must reach the hung tool phase before time advances");

	let settledEarly = false;
	void responseP.then(() => { settledEarly = true; }, () => { settledEarly = true; });
	await clock.advance(30 * 60_000); // far beyond the old 15-minute running_tool lease
	await flushAsync();
	assert.equal(settledEarly, false, "a hung tool phase must not be force-settled by any time bound");

	controller.abort();
	const response = await within(5000, responseP);
	assert.equal(response.isError, true);
	assert.match(response.details.results[0]?.finalOutput ?? "", /answer before tool/, "partial output survives explicit cancellation");
});

test("execute(): a normal dispatch arms no timers and returns the real result", async () => {
	const clock = new FakeClock();
	setMockBehavior({
		onPrompt: (emit: (event: unknown) => void) => {
			emit(messageEnd("done", "completed"));
		},
	});

	const response = await within(2000, execute(
		"tool-no-timers",
		{ agent: "worker", task: "do work" } as never,
		new AbortController().signal,
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
		{ clock },
	));

	assert.equal(response.isError, undefined);
	const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "";
	assert.equal(text, "done");
	assert.equal(clock.setTimerCalls, 0, "settlement must not be replaced with another time guess");
});

test("execute(): a normal nested terminal emits recursive_projection with measured duration before terminal", async () => {
	const sinkKey = Symbol.for("pie.runtime-trace-sink.v1");
	const target = globalThis as Record<PropertyKey, unknown>;
	const previous = target[sinkKey];
	const events: Array<Record<string, unknown>> = [];
	target[sinkKey] = (event: unknown) => events.push(event as Record<string, unknown>);
	const nestedDetails = {
		mode: "single",
		results: [{
			agent: "scout",
			task: "nested",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "nested final" }] }],
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
		}],
	};
	setMockBehavior({
		onPrompt: (emit: (event: unknown) => void) => {
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "nested-call", name: "subagent", arguments: {} }],
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
					model: "m",
					stopReason: "toolUse",
				},
			});
			emit({ type: "tool_execution_start", toolCallId: "nested-call", toolName: "subagent" });
			emit({
				type: "tool_execution_update",
				toolCallId: "nested-call",
				partialResult: {
					content: [{ type: "text", text: "nested running" }],
					details: nestedDetails,
				},
			});
			emit({ type: "tool_execution_end", toolCallId: "nested-call", toolName: "subagent" });
			emit(messageEnd("done", "completed"));
		},
	});
	try {
		const response = await within(5000, execute(
			"tool-normal-nested",
			{ agent: "worker", task: "do nested work" } as never,
			new AbortController().signal,
			() => undefined,
			makeCtx() as never,
			{ getAllTools: () => [] } as never,
			() => false,
		));
		assert.equal(response.isError, undefined, "the normal nested completion must not be force-settled");
	} finally {
		if (previous === undefined) delete target[sinkKey];
		else target[sinkKey] = previous;
	}

	const projections = events.filter((event) => event.phase === "recursive_projection");
	assert.equal(projections.length, 1, "the normal terminal emits exactly one recursive_projection");
	const projection = projections[0]!;
	assert.equal(projection.payloadClass, undefined);
	assert.ok(
		typeof projection.durationMs === "number" && (projection.durationMs as number) >= 0,
		"recursive_projection carries the duration measured inside the terminal traversal",
	);
	assert.equal(projection.childCount, 2, "outer result plus the nested subagent result");
	assert.equal(projection.messageCount, 3, "two outer messages plus the nested result message");
	assert.equal(projection.maxRecursiveDepth, 2, "the nested result is projected one level deep");
	const projectionIndex = events.indexOf(projection);
	assert.equal(events[projectionIndex + 1]?.phase, "terminal", "the measured projection precedes the terminal handoff");
	assert.equal(events.some((event) => event.phase === "measure"), false, "no timeout selection is reported as payload measurement");
	assert.equal(events.some((event) => event.payloadClass === "terminal_append"), false, "execute has not crossed the SDK durability boundary");
	assert.equal(events.some((event) => event.phase === "json_safe_normalization"), false, "no producer claims JSON-safe normalization for the recursive terminalization");
});

test("execute(): AbortSignal.any fallback removes parent listeners after settlement", async () => {
	setMockBehavior({
		onPrompt: (emit: (event: unknown) => void) => {
			emit(messageEnd("done", "completed"));
		},
	});
	const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");
	Object.defineProperty(AbortSignal, "any", { configurable: true, writable: true, value: undefined });
	const parent = new AbortController();
	const baseline = getEventListeners(parent.signal, "abort").length;
	try {
		for (let i = 0; i < 15; i++) {
			const response = await within(2000, execute(
				`tool-listener-${i}`,
				{ agent: "worker", task: "do work" } as never,
				parent.signal,
				() => undefined,
				makeCtx() as never,
				{ getAllTools: () => [] } as never,
				() => false,
			));
			assert.equal(response.isError, undefined);
		}
		assert.equal(getEventListeners(parent.signal, "abort").length, baseline);
	} finally {
		if (descriptor) Object.defineProperty(AbortSignal, "any", descriptor);
		else delete (AbortSignal as { any?: unknown }).any;
	}
});

test("execute(): parent abort settles even when child abort never resolves", async () => {
	setMockBehavior({
		onPrompt: () => new Promise<void>(() => {}),
		onAbort: () => new Promise<void>(() => {}),
	});

	const controller = new AbortController();
	const responseP = execute(
		"tool-abort-hangs",
		{ agent: "worker", task: "do work" } as never,
		controller.signal,
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
	);
	// Abort shortly after dispatch starts. The prompt race must settle
	// independently of session.abort() — detached cleanup owns remote teardown.
	setTimeout(() => controller.abort(), 30);
	const response = await within(2000, responseP);

	assert.equal(response.isError, true);
	const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "";
	assert.match(text, /abort/i);
});