/**
 * Direct unit tests for the pure chain/parallel helpers in
 * extensions/subagent/src/modes.ts:
 *   formatParallelResult, formatChainSuccessResult,
 *   buildChainStepFailureResponse, checkChainPreFlight.
 *
 * modes.ts only type-imports `@mariozechner/pi-agent-core` / `pi-coding-agent`
 * (erased at runtime), so a plain ESM import resolves under tsx — no SDK-mock
 * bootstrap needed. These helpers take already-built SingleResult[] / plain
 * step data, so they run sub-ms with no LLM or network.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isModelFailure } from "../src/selection.js";
import type { SingleResult, SubagentDetails } from "../types.js";

function usage(over: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number; contextTokens: number }> = {}) {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, ...over };
}

function result(over: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "worker",
		agentSource: "user",
		task: "do the thing",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: usage(),
		...over,
	} as SingleResult;
}

function assistantMsg(text: string): any {
	return { role: "assistant", content: [{ type: "text", text }], model: "m" };
}


// ---------------------------------------------------------------------------
// execute* mode tests
// ---------------------------------------------------------------------------
// modes.ts execute* functions call `runSingleAgent` (../runner.js), which lazily
// does `import("@mariozechner/pi-coding-agent")`. That bare specifier does not
// resolve from the repo root under tsx, and `node:test`'s `mock.module` is not
// available in this Node. So we register an ESM `resolve` hook via
// `module.register()` (callable at runtime, no CLI flag) that redirects the
// specifier to an in-memory mock SDK. The mock reads its per-prompt behaviour
// from `globalThis.__MOCK_SDK_BEHAVIOR__`, so each test drives success / failure
// without any real LLM or network. `selectionCtx.alwaysParentModel = true` keeps
// `resolveModel` pure (no analytics I/O). Every case is sub-200ms.

const MOCK_SDK_SOURCE = [
	"export class DefaultResourceLoader { constructor(a){ this.a = a; } async reload(){} }",
	"export const SessionManager = { inMemory(cwd){ return { cwd: cwd }; } };",
	"export function getAgentDir(){ return '.'; }",
	"export async function createAgentSession(args){",
	"  const listeners = [];",
	"  let release;",
	"  const session = {",
	"    agent: { state: { model: { id: 'session-model' } } },",
	"    extensionRunner: { setUIContext(ctx){ (globalThis.__MOCK_PROXIES__ = globalThis.__MOCK_PROXIES__ || []).push(ctx); } },",
	"    subscribe(cb){ listeners.push(cb); return () => {}; },",
	"    async prompt(p){",
	"      const b = globalThis.__MOCK_SDK_BEHAVIOR__;",
	"      if (b && b.onPrompt) { await b.onPrompt(function(ev){ for (const l of listeners) l(ev); }, p); return; }",
	"      await new Promise(function(r){ release = r; });",
	"    },",
	"    async abort(){ if (release) release(); },",
	"    dispose(){}",
	"  };",
	"  return { session: session };",
	"}",
].join("\n");

const __mockSdkDir = mkdtempSync(path.join(tmpdir(), "modes-mock-sdk-"));
const __mockSdkPath = path.join(__mockSdkDir, "mock-sdk.mjs");
writeFileSync(__mockSdkPath, MOCK_SDK_SOURCE, "utf-8");
const __hookPath = path.join(__mockSdkDir, "hook.mjs");
writeFileSync(
	__hookPath,
	[
		"export async function resolve(specifier, context, nextResolve){",
		`  if (specifier === '@mariozechner/pi-coding-agent') return { url: ${JSON.stringify(pathToFileURL(__mockSdkPath).href)}, shortCircuit: true };`,
		"  return nextResolve(specifier, context);",
		"}",
	].join("\n"),
	"utf-8",
);
// Register the hook before requiring modes.ts via createRequire: modes.ts imports
// runner.js (CJS), whose loadSubagentSdk() does a dynamic import() of the SDK —
// native import() is intercepted by the registered ESM resolve hook.
Module.register(pathToFileURL(__hookPath));
const __require = createRequire(import.meta.url);
const __modesPath = path.resolve("extensions/subagent/src/modes.ts");
const { executeSingleMode } = __require(__modesPath) as typeof import("../src/modes.js");
// Loose aliases so the many-arg orchestration calls read cleanly.
const execSingle = executeSingleMode as any;

function makeCtx(): any {
	return {
		cwd: process.cwd(),
		model: { id: "active-model", provider: "test" },
		modelRegistry: {
			getAvailable: () => [{ id: "active-model", provider: "test" }],
			getAll: () => [{ id: "active-model", provider: "test" }],
			find: (_provider: string, id: string) => (id === "active-model" ? { id: "active-model", provider: "test" } : undefined),
		},
	};
}
function makeAgents(): any[] {
	return [{ name: "worker", description: "d", systemPrompt: "", source: "user", filePath: "w.md" }];
}
function selCtx(over: Record<string, unknown> = {}): any {
	return { modelConfig: [], disabledProviders: new Set(), allowedModelIds: undefined, bucketAssignments: undefined, alwaysParentModel: true, nestedAllowedBuckets: { small: true, medium: true, frontier: true }, ...over };
}
function setMockBehavior(b: any): void {
	(globalThis as any).__MOCK_SDK_BEHAVIOR__ = b;
}
// Prevent behavior from leaking across tests: every test currently sets its own
// behavior, but resetting here means a future test that forgets to call
// setMockBehavior cannot inherit a previous test's SDK behavior. Also reset the
// captured-proxy sink used by the subagentCallId-stamping regression tests.
afterEach(() => { setMockBehavior(undefined); (globalThis as any).__MOCK_PROXIES__ = []; });

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
function successBehavior(text: string): any {
	return { onPrompt: async (emit: any) => { emit(messageEnd(text, "completed")); } };
}

const noSignal = () => new AbortController().signal;
const noOpDetails = (mode: any, results: any[]) => ({ mode, agentScope: "user" as const, projectAgentsDir: null, results });

// --- executeSingleMode ------------------------------------------------------

test("executeSingleMode: success returns the final assistant output", async () => {
	setMockBehavior(successBehavior("all done"));
	const r: any = await execSingle(
		{ agent: "worker", task: "do work" }, makeCtx(), makeAgents(),
		() => undefined, { depth: 0, trail: [] }, noOpDetails, undefined, noSignal(), selCtx(), "t1", undefined,
	);
	assert.equal(r.isError, undefined);
	assert.equal(r.content[0].text, "all done");
	assert.equal(r.details.mode, "single");
	assert.equal(r.details.results.length, 1);
	assert.equal(r.details.results[0].exitCode, 0);
	assert.equal(r.details.results[0].model, "m");
});

test("executeSingleMode: error result returns isError with 'Agent <stopReason>: <message>'", async () => {
	setMockBehavior({ onPrompt: async (emit: any) => { emit(messageEnd("partial", "error")); } });
	const r: any = await execSingle(
		{ agent: "worker", task: "do work" }, makeCtx(), makeAgents(),
		() => undefined, { depth: 0, trail: [] }, noOpDetails, undefined, noSignal(), selCtx(), "t1", undefined,
	);
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /Agent error: partial/);
	assert.equal(r.details.results[0].exitCode, 1);
	assert.equal(r.details.results[0].stopReason, "error");
});

test("executeSingleMode: trail loop short-circuits before runSingleAgent", async () => {
	let called = false;
	setMockBehavior({ onPrompt: async () => { called = true; } });
	await assert.rejects(
		() => execSingle(
			{ agent: "worker", task: "do work" }, makeCtx(), makeAgents(),
			() => undefined, { depth: 0, trail: ["worker", "worker"] }, noOpDetails, undefined, noSignal(), selCtx(), "t1", undefined,
		),
		/Trail loop detected: agent "worker"/,
	);
	assert.equal(called, false, "trail loop must not reach runSingleAgent");
});

test("executeSingleMode: an unclassified task/model error is not replayed on another model", async () => {
	// A non-zero exit alone is not retry-safe. Without a transient provider
	// classification, failover could duplicate prose or external tool effects.
	let attempts = 0;
	setMockBehavior({ onPrompt: async (emit: any) => { attempts++; emit(messageEnd("partial", "error")); } });
	const r: any = await execSingle(
		{ agent: "worker", task: "do work" }, makeCtx(), makeAgents(),
		() => undefined, { depth: 0, trail: [] }, noOpDetails, undefined, noSignal(), selCtx({ alwaysParentModel: false, bucketAssignments: {} }), "t1", undefined,
	);
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /Agent error: partial/);
	assert.equal(attempts, 1);
	assert.equal(r.details.results[0].failedModel, undefined);
	assert.equal(r.details.results[0].retryCount, undefined);
});

test("isModelFailure allows only transient, side-effect-safe failures", () => {
	const base = result({ exitCode: 1, stopReason: "error" });
	assert.equal(isModelFailure({ ...base, retryable: true, replaySafety: "safe" }, "model-a", true), true);
	assert.equal(isModelFailure({ ...base, retryable: false, replaySafety: "terminal" }, "model-a", true), false);
	assert.equal(isModelFailure({ ...base, retryable: true, replaySafety: "partial_output" }, "model-a", true), false);
	assert.equal(isModelFailure({ ...base, retryable: true, replaySafety: "tool_side_effect" }, "model-a", true), false);
});

test("transient provider timeout retries on another model in the same bucket", async () => {
	let attempts = 0;
	setMockBehavior({
		onPrompt: async (emit: any) => {
			attempts++;
			if (attempts === 1) {
				const error = Object.assign(new Error("provider timed out after retries exhausted"), { code: "ETIMEDOUT" });
				throw error;
			}
			emit(messageEnd("recovered", "completed"));
		},
	});
	const models = [
		{ id: "model-a", provider: "test" },
		{ id: "model-b", provider: "test" },
	];
	const ctx = {
		...makeCtx(),
		model: models[0],
		modelRegistry: {
			getAvailable: () => models,
			getAll: () => models,
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		},
	};
	const originalRandom = Math.random;
	Math.random = () => 0;
	try {
		const response: any = await execSingle(
			{ agent: "worker", task: "do work", bucket: "medium" }, ctx, makeAgents(),
			() => undefined, { depth: 0, trail: [] }, noOpDetails, undefined, noSignal(),
			selCtx({ alwaysParentModel: false, fallbackOnProviderFailure: true, bucketAssignments: { small: [], medium: ["model-a", "model-b"], frontier: [] } }),
			"t-retry", undefined,
		);
		assert.equal(response.isError, undefined);
		assert.equal(response.content[0].text, "recovered");
		assert.equal(attempts, 2);
		assert.equal(response.details.results[0].retryCount, 1);
		assert.equal(response.details.results[0].failedModel, "model-a");
		assert.equal(response.details.results[0].selectedModel, "model-b");
	} finally {
		Math.random = originalRandom;
	}
});

test("a retry attempt cannot receive a stale trailing update from the failed attempt", async () => {
	let attempts = 0;
	setMockBehavior({
		onPrompt: async (emit: any) => {
			attempts++;
			if (attempts === 1) {
				// Tool-call argument generation is credible provider activity but not
				// visible output or a side effect, so this transport failure remains
				// replay-safe. The second burst schedules the 20fps trailing update.
				emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta" } });
				emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta" } });
				throw Object.assign(new Error("provider timed out after retries exhausted"), { code: "ETIMEDOUT" });
			}
			// Keep attempt B open beyond the 50ms throttle window. Without closing
			// attempt A's emitter, its trailing callback publishes in this window.
			await new Promise((resolve) => setTimeout(resolve, 80));
			emit(messageEnd("recovered", "completed"));
		},
	});
	const models = [
		{ id: "model-a", provider: "test" },
		{ id: "model-b", provider: "test" },
	];
	const ctx = {
		...makeCtx(),
		model: models[0],
		modelRegistry: {
			getAvailable: () => models,
			getAll: () => models,
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		},
	};
	const publishedModels: Array<string | undefined> = [];
	const originalRandom = Math.random;
	Math.random = () => 0;
	try {
		const response: any = await execSingle(
			{ agent: "worker", task: "do work", bucket: "medium" }, ctx, makeAgents(),
			() => undefined, { depth: 0, trail: [] }, noOpDetails,
			(update: any) => publishedModels.push(update.details.results[0]?.selectedModel), noSignal(),
			selCtx({ alwaysParentModel: false, fallbackOnProviderFailure: true, bucketAssignments: { small: [], medium: ["model-a", "model-b"], frontier: [] } }),
			"t-retry-terminal-fence", undefined,
		);
		assert.equal(response.isError, undefined);
		assert.equal(attempts, 2);
		const retryStart = publishedModels.indexOf("model-b");
		assert.ok(retryStart >= 0, `retry attempt B published its lifecycle: ${JSON.stringify(publishedModels)}`);
		assert.equal(
			publishedModels.slice(retryStart).includes("model-a"),
			false,
			"attempt A cannot publish after attempt B takes ownership",
		);
	} finally {
		Math.random = originalRandom;
	}
});

test("exhausted bucket does not fall back outside the bucket or report an unstarted retry", async () => {
	let attempts = 0;
	setMockBehavior({ onPrompt: async () => {
		attempts++;
		throw Object.assign(new Error("connection reset after retries exhausted"), { code: "ECONNRESET" });
	} });
	const models = [
		{ id: "parent-model", provider: "parent-provider" },
		{ id: "bucket-model", provider: "bucket-provider" },
	];
	const ctx = {
		...makeCtx(),
		model: models[0],
		modelRegistry: {
			getAvailable: () => models,
			getAll: () => models,
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		},
	};
	const response: any = await execSingle(
		{ agent: "worker", task: "do work", bucket: "medium" }, ctx, makeAgents(),
		() => undefined, { depth: 0, trail: [] }, noOpDetails, undefined, noSignal(),
		selCtx({ alwaysParentModel: false, fallbackOnProviderFailure: true, bucketAssignments: { small: [], medium: ["bucket-model"], frontier: [] } }),
		"t-exhausted", undefined,
	);
	assert.equal(response.isError, true);
	assert.equal(attempts, 1);
	assert.equal(response.details.results[0].selectedModel, "bucket-model");
	assert.equal(response.details.results[0].retryCount, undefined);
	assert.equal(response.details.results[0].failedModel, undefined);
});

test("provider fallback toggle off surfaces the first transient failure", async () => {
	let attempts = 0;
	setMockBehavior({ onPrompt: async () => {
		attempts++;
		throw Object.assign(new Error("provider timed out"), { code: "ETIMEDOUT" });
	} });
	const response: any = await execSingle(
		{ agent: "worker", task: "do work", bucket: "medium" }, makeCtx(), makeAgents(),
		() => undefined, { depth: 0, trail: [] }, noOpDetails, undefined, noSignal(),
		selCtx({ alwaysParentModel: false, fallbackOnProviderFailure: false, bucketAssignments: { small: [], medium: ["active-model", "other-model"], frontier: [] } }),
		"t-no-retry", undefined,
	);
	assert.equal(response.isError, true);
	assert.equal(attempts, 1);
	assert.equal(response.details.results[0].retryCount, undefined);
});

test("executeSingleMode: parent abort is terminal and never starts a fallback model attempt", async () => {
	const controller = new AbortController();
	let attempts = 0;
	setMockBehavior({
		onPrompt: async () => {
			attempts++;
			controller.abort();
			await new Promise(() => {}); // hang so the abort race wins cleanly
		},
	});
	const models = [
		{ id: "model-a", provider: "test" },
		{ id: "model-b", provider: "test" },
	];
	const ctx = {
		...makeCtx(),
		model: models[0],
		modelRegistry: {
			getAvailable: () => models,
			getAll: () => models,
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		},
	};
	const selection = selCtx({
		alwaysParentModel: false,
		bucketAssignments: { small: [], medium: ["model-a", "model-b"], frontier: [] },
	});

	const r: any = await execSingle(
		{ agent: "worker", task: "do work", bucket: "medium" }, ctx, makeAgents(),
		() => undefined, { depth: 0, trail: [] }, noOpDetails, undefined, controller.signal, selection, "t-abort", undefined,
	);

	assert.equal(r.isError, true);
	assert.equal(attempts, 1, "Stop must not launch a fresh fallback session");
	assert.equal(r.details.results[0].stopReason, "aborted");
	assert.equal(r.details.results[0].activityPhase, "cancelled");
	assert.deepEqual(r.details.results[0].runningTools, []);
	assert.equal(r.details.results[0].streaming, false);
	assert.match(r.details.results[0].errorMessage ?? "", /Subagent aborted \(while waiting for model response\)/);
	assert.equal(r.details.results[0].retryCount, undefined);
});

function createStampCaptureBridge() {
	const calls: { select: { opts: any }[] } = { select: [] };
	return {
		calls,
		async select(_title: string, _options: string[], opts?: any) { calls.select.push({ opts }); return "x"; },
		async confirm() { return true; },
		async input() { return "x"; },
		notify() {},
		cancelAll() {},
	} as any;
}

test("executeSingleMode stamps the bare tool-call id (single result -> bare id)", async () => {
	const bridge = createStampCaptureBridge();
	setMockBehavior({ onPrompt: async (emit: any) => {
		const proxy = (globalThis as any).__MOCK_PROXIES__.at(-1);
		await proxy.select("q", ["a"]);
		emit(messageEnd("ok", "completed"));
	} });
	await execSingle(
		{ agent: "worker", task: "s" }, makeCtx(), makeAgents(),
		() => undefined, { depth: 0, trail: [] }, noOpDetails, undefined, noSignal(), selCtx(), "callD", bridge,
	);
	assert.equal(bridge.calls.select[0].opts.subagentCallId, "callD");

	const capturedProxy = (globalThis as any).__MOCK_PROXIES__[0];
	assert.equal(await capturedProxy.select("late", ["x"]), undefined);
	assert.equal(bridge.calls.select.length, 1, "a terminal session's captured proxy stays fenced");
});
