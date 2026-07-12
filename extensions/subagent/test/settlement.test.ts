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
import { execute } from "../src/execute.js";

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
	"PIE_SUBAGENT_MAX_CONCURRENCY",
	"PIE_SUBAGENT_MAX_PARALLEL_TASKS",
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
	delete process.env.PIE_SUBAGENT_MAX_CONCURRENCY;
	delete process.env.PIE_SUBAGENT_MAX_PARALLEL_TASKS;
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
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "50"; // tiny net
	process.env.PIE_SUBAGENT_SETTLEMENT_GRACE_MS = "0"; // skip grace → synthesize immediately
	setMockBehavior({
		onPrompt: (emit: (event: unknown) => void) => {
			emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial progress" } });
			return new Promise<void>(() => {});
		},
	});

	const response = await within(2000, execute(
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
	assert.equal(response.details.results[0]?.streamingText, "partial progress");
	assert.equal(response.details.results[0]?.exitCode, 1);
});

test("execute(): high configured concurrency does not weaken bounded settlement", async () => {
	// Correctness must not depend on reducing concurrency to 2. Exercise the
	// maximum supported local cap with several completely silent children.
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "16";
	process.env.PIE_SUBAGENT_MAX_CONCURRENCY = "16";
	process.env.PIE_SUBAGENT_MAX_PARALLEL_TASKS = "16";
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "50";
	process.env.PIE_SUBAGENT_SETTLEMENT_GRACE_MS = "0";
	setMockBehavior(hangingPromptBehavior());

	const tasks = Array.from({ length: 4 }, (_, index) => ({
		agent: "worker",
		task: `silent work ${index + 1}`,
	}));
	const response = await within(2000, execute(
		"tool-settle-high-concurrency",
		{ tasks } as never,
		new AbortController().signal,
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
	));

	assert.equal(response.isError, true);
	assert.equal(response.details.results.length, 4);
	assert.ok(response.details.results.every((result) => result.exitCode === 1));
});

test("execute(): periodic credible progress renews the inactivity deadline", async () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "80";
	process.env.PIE_SUBAGENT_SETTLEMENT_GRACE_MS = "0";
	setMockBehavior({
		onPrompt: async (emit: (event: unknown) => void) => {
			// Total runtime exceeds 80ms, but every idle gap is well below it. A
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
