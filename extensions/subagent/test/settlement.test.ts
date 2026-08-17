/**
 * Settlement-net tests (Slice B): `execute()` MUST return after
 * `PIE_SUBAGENT_SETTLEMENT_MS` without credible progress, even if a downstream
 * phase (here: a prompt that never resolves and ignores abort) hangs forever.
 * Progress renews the inactivity deadline, so this last-resort net bounds a
 * silent dispatch without imposing a total-runtime cap on productive work.
 *
 * Approach: register an ESM resolve hook (same technique as modes.test.ts) that
 * redirects `@mariozechner/pi-coding-agent` to an in-memory mock whose `prompt`
 * reads `globalThis.__MOCK_SDK_BEHAVIOR__`. A never-resolving `onPrompt`
 * simulates a dead provider stream / hung SDK that ignores abort — exactly the
 * case the settlement net must catch. Kept self-contained (own mock + hook) but
 * idempotent: a global guard prevents double-registration if modes.test.ts
 * already installed a hook in the same process.
 */

import test, { afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import Module from "node:module";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createProgressObserver, execute } from "../src/execute.js";

// ---------------------------------------------------------------------------
// In-memory mock SDK + ESM resolve hook (redirect @mariozechner/pi-coding-agent)
// ---------------------------------------------------------------------------

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
	"PIE_SUBAGENT_SETTLEMENT_MS",
	"PIE_SUBAGENT_SETTLEMENT_GRACE_MS",
	"PIE_SUBAGENT_TIMEOUT_MS",
	"PIE_SUBAGENT_MAX_INFLIGHT",
	"PIE_SUBAGENT_ALWAYS_PARENT_MODEL",
	"PI_CODING_AGENT_DIR",
	"PI_SUBAGENT_TIMEOUT_MS",
	"PI_SUBAGENT_DEPTH",
] as const;

const snapshot: Record<string, string | undefined> = {};
test.before(() => {
	for (const key of ENV_KEYS) snapshot[key] = process.env[key];
	// Force the mock SDK to always-parent-model (pure selection, no analytics),
	// a generous inflight cap so the permit never blocks, and disable the
	// per-prompt timeout so the ONLY thing that can settle a hung dispatch is
	// the settlement net (what we're testing). A generous default grace so the
	// abort path gets a real window unless a test overrides it.
	process.env.PIE_SUBAGENT_ALWAYS_PARENT_MODEL = "1";
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "8";
	process.env.PIE_SUBAGENT_TIMEOUT_MS = "0";
	process.env.PIE_SUBAGENT_SETTLEMENT_GRACE_MS = "200";
	delete process.env.PI_SUBAGENT_TIMEOUT_MS;
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
	process.env.PIE_SUBAGENT_SETTLEMENT_GRACE_MS = "200";
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

/** A prompt that hangs forever and ignores `abort()` (release stays unset):
 *  simulates a dead provider stream / hung SDK that never settles. Uses a bare
 *  never-resolving promise (no timer handle) so it never holds the event loop. */
function hangingPromptBehavior(): { onPrompt: () => Promise<void> } {
	return {
		onPrompt: () => new Promise<void>(() => {}),
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("execute(): a dispatch that never reports progress is force-settled after PIE_SUBAGENT_SETTLEMENT_MS of inactivity", async () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "500"; // short net with headroom for SDK setup under full-suite load
	process.env.PIE_SUBAGENT_SETTLEMENT_GRACE_MS = "0"; // skip grace → synthesize immediately
	setMockBehavior({
		onPrompt: (emit: (event: unknown) => void) => {
			emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial progress" } });
			return new Promise<void>(() => {});
		},
	});

	const response = await within(5000, execute(
		"tool-settle-1",
		{ agent: "worker", task: "do work" } as never,
		new AbortController().signal, // no parent abort — the net is the only escape
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
	));

	assert.equal(response.isError, true);
	const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "";
	// Either the synthesized force-settle message, or the runner's abort result
	// (which arrives during the grace window after the settlement abort). Both
	// are acceptable "loud" outcomes — what matters is execute() returned.
	assert.match(text, /force-settled|settle|abort/i);
	assert.equal(response.details.results.length, 1);
	assert.equal(response.details.results[0]?.finalOutput, "partial progress");
	assert.equal(response.details.results[0]?.exitCode, 1);
});

test("execute(): trace phases describe clone and terminal work, not timeout selection", async () => {
	const sinkKey = Symbol.for("pie.runtime-trace-sink.v1");
	const target = globalThis as Record<PropertyKey, unknown>;
	const previous = target[sinkKey];
	const events: Array<Record<string, unknown>> = [];
	target[sinkKey] = (event: unknown) => events.push(event as Record<string, unknown>);
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "40";
	process.env.PIE_SUBAGENT_SETTLEMENT_GRACE_MS = "0";
	setMockBehavior({
		onPrompt: (emit: (event: unknown) => void) => {
			emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } });
			return new Promise<void>(() => {});
		},
	});
	try {
		await within(2000, execute(
			"tool-trace-phases",
			{ agent: "worker", task: "trace work" } as never,
			new AbortController().signal,
			() => undefined,
			makeCtx() as never,
			{ getAllTools: () => [] } as never,
			() => false,
		));
	} finally {
		if (previous === undefined) delete target[sinkKey];
		else target[sinkKey] = previous;
	}

	assert.ok(events.some((event) => event.phase === "source_update" && event.payloadClass === "source"));
	assert.ok(events.some((event) => event.phase === "clone" && event.childCount === 1));
	assert.ok(events.some((event) => event.phase === "dedupe" && event.outcome === "changed"), "the execute-boundary observer emits its closed dedupe outcome");
	assert.ok(events.some((event) => event.phase === "recursive_projection"
		&& event.payloadClass === undefined
		&& event.childCount === 1), "the terminal compactSubagentDetails traversal is a recursive projection, not a durable append");
	assert.ok(events.some((event) => event.phase === "terminal"
		&& event.payloadClass === undefined
		&& event.childCount === 1
		&& event.messageCount === 0
		&& event.maxRecursiveDepth === 1));
	assert.equal(events.some((event) => event.payloadClass === "terminal_append"), false, "execute has not crossed the SDK durability boundary");
	assert.equal(events.some((event) => event.phase === "measure"), false, "timeout selection is not payload measurement");
	assert.equal(events.some((event) => event.phase === "json_safe_normalization"), false, "no producer claims JSON-safe normalization for the recursive terminalization");
});

test("execute(): a normal nested terminal emits recursive_projection with measured duration before terminal", async () => {
	const sinkKey = Symbol.for("pie.runtime-trace-sink.v1");
	const target = globalThis as Record<PropertyKey, unknown>;
	const previous = target[sinkKey];
	const events: Array<Record<string, unknown>> = [];
	target[sinkKey] = (event: unknown) => events.push(event as Record<string, unknown>);
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "0"; // net OFF → the normal success terminal path
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
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
					model: "m",
					stopReason: "completed",
				},
			});
		},
	});
	try {
		const response = await within(5000, execute(
			"tool-settle-normal-nested",
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
});

test("execute(): periodic credible progress renews the inactivity deadline", async () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "100";
	process.env.PIE_SUBAGENT_SETTLEMENT_GRACE_MS = "0";
	setMockBehavior({
		onPrompt: async (emit: (event: unknown) => void) => {
			// Total runtime exceeds 100ms, but every idle gap is well below it. A
			// fixed wall-clock deadline would force-settle this productive run.
			for (const delta of ["still ", "working ", "normally "]) {
				await sleep(30);
				emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
			}
			await sleep(30);
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done after sustained progress" }],
					usage: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0 } },
					model: "m",
					stopReason: "completed",
				},
			});
		},
	});

	const response = await within(2000, execute(
		"tool-settle-renew",
		{ agent: "worker", task: "do long productive work" } as never,
		new AbortController().signal,
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
	));

	assert.equal(response.isError, undefined);
	assert.equal((response.content?.[0] as { text?: string } | undefined)?.text, "done after sustained progress");
});

test("createProgressObserver rejects stale 5 → 4 → 5 generations within one attempt", () => {
	const observe = createProgressObserver();
	const details = (progressGeneration: number, provider = "provider-a", model = "model-a") => ({
		results: [{
			agent: "scout", task: "nested", step: 1, provider, model, progressGeneration,
			messages: [], usage: { input: 0, output: 0, turns: 0 },
		}],
	}) as never;

	assert.equal(observe(details(5)), true, "the first snapshot establishes the attempt");
	assert.equal(observe(details(4)), false, "a decreasing generation is stale");
	assert.equal(observe(details(5)), false, "returning to the high-water mark is still stale");
	assert.equal(observe(details(6)), true, "only a value above the high-water mark renews");
	assert.equal(observe(details(0, "provider-a", "model-b")), true, "a model change starts a new attempt");
	assert.equal(observe(details(0, "provider-a", "model-b")), false, "the reset cannot repeat on the same model");
	assert.equal(observe(details(0, "provider-b", "model-b")), true, "a provider change also starts a new attempt");
});

test("execute(): repeated identical tool updates do not indefinitely renew the settlement lease", async () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "55";
	process.env.PIE_SUBAGENT_SETTLEMENT_GRACE_MS = "0";
	const identicalNestedPartial = {
		content: [{ type: "text", text: "nested still waiting" }],
		details: {
			mode: "single",
			results: [{ agent: "scout", task: "nested", exitCode: -1, messages: [], progressGeneration: 3 }],
		},
	};
	setMockBehavior({
		onPrompt: async (emit: (event: unknown) => void) => {
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
			// These callbacks continue past the 55ms lease, but carry the exact
			// same nested generation and payload every time: they are not progress.
			for (let i = 0; i < 8; i++) {
				await sleep(15);
				emit({ type: "tool_execution_update", toolCallId: "nested-call", partialResult: identicalNestedPartial });
			}
			await new Promise<void>(() => {});
		},
	});

	const response = await within(2000, execute(
		"tool-settle-identical-updates",
		{ agent: "worker", task: "do work" } as never,
		new AbortController().signal,
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
	));

	// The only configured failure path is the settlement net: identical updates
	// continued beyond the lease, yet the dispatch still returned as an error.
	assert.equal(response.isError, true);
});

test("execute(): nested descendant progress renews the root settlement lease", async () => {
	// Keep a wide wall-clock margin for the all-package test runner, where many
	// real child processes can temporarily delay Node timers. Total duration is
	// still greater than the lease, so this continues to distinguish a renewed
	// inactivity deadline from a fixed total-duration deadline.
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "300";
	process.env.PIE_SUBAGENT_SETTLEMENT_GRACE_MS = "0";
	setMockBehavior({
		onPrompt: async (emit: (event: unknown) => void) => {
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
			// Total duration is greater than the lease. Each changed descendant
			// generation reaches this root runner via tool_execution_update.
			for (let generation = 1; generation <= 6; generation++) {
				await sleep(60);
				emit({
					type: "tool_execution_update",
					toolCallId: "nested-call",
					partialResult: {
						content: [{ type: "text", text: `nested step ${generation}` }],
						details: {
							mode: "single",
							results: [{ agent: "scout", task: "nested", exitCode: -1, messages: [], progressGeneration: generation }],
						},
					},
				});
			}
			emit({ type: "tool_execution_end", toolCallId: "nested-call", toolName: "subagent" });
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "nested work complete" }],
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
					model: "m",
					stopReason: "completed",
				},
			});
		},
	});

	const response = await within(5000, execute(
		"tool-settle-nested-progress",
		{ agent: "worker", task: "do nested work" } as never,
		new AbortController().signal,
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
	));

	assert.equal(response.isError, undefined);
	assert.match((response.content?.[0] as { text?: string } | undefined)?.text ?? "", /nested work complete/);
});

test("execute(): parent abort settles even when child abort never resolves and the settlement net is disabled", async () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "0"; // net OFF
	setMockBehavior({
		onPrompt: () => new Promise<void>(() => {}),
		onAbort: () => new Promise<void>(() => {}),
	});

	const controller = new AbortController();
	const responseP = execute(
		"tool-settle-2",
		{ agent: "worker", task: "do work" } as never,
		controller.signal,
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
	);
	// Abort shortly after dispatch starts; with the net off this is the only
	// way out. The prompt race must settle independently of session.abort().
	setTimeout(() => controller.abort(), 30);
	const response = await within(2000, responseP);

	assert.equal(response.isError, true);
	const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "";
	assert.match(text, /abort/i);
});

test("execute(): AbortSignal.any fallback removes parent listeners after normal settlement", async () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "500";
	setMockBehavior({
		onPrompt: (emit: (event: unknown) => void) => {
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
					model: "m",
					stopReason: "completed",
				},
			});
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

test("execute(): a normally-completing dispatch is unaffected by the settlement net (returns the real result, not force-settled)", async () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "50"; // net ON but small — must NOT fire for a fast success
	setMockBehavior({
		onPrompt: (emit: (event: unknown) => void) => {
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
					model: "m",
					stopReason: "completed",
				},
			});
		},
	});

	const response = await within(2000, execute(
		"tool-settle-3",
		{ agent: "worker", task: "do work" } as never,
		new AbortController().signal,
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
	));

	// Real success result, not a force-settle error.
	assert.equal(response.isError, undefined);
	const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "";
	assert.equal(text, "done");
});
