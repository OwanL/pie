/** Behavioral coverage for the production executeSingleTask object API. */
import { bootstrapMockSdk, SESSION_MOCK_SDK_SOURCE } from "./helpers/mock-sdk-bootstrap.js";
import test, { after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { isModelFailure } from "../selection.js";
import { hashDelegatedPrompt } from "../runtime-provenance.js";
import { resetFairSelectionBags } from "../bucket-selector.js";
import type { SingleResult, SubagentDetails } from "../types.js";

function usage(over: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number; contextTokens: number }> = {}) {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, ...over };
}

function assignedModels(...models: string[]) {
	return models.map((model) => ({ model, thinkingLevel: "high" as const }));
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
// single.ts executeSingleTask call `runSingleAgent` (../runner.js), which lazily
// imports the SDK. The shared TSX config maps canonical and legacy SDK
// specifiers to the selected artifact's same dist/index.js, so the ESM resolve
// hook must match that exact configured path as well as intentional bare SDK
// identities. `node:test`'s `mock.module` is not available in this Node; the
// in-memory mock reads its per-prompt behaviour from
// `globalThis.__MOCK_SDK_BEHAVIOR__`, keeping each case network-free.
// `selectionCtx.alwaysParentModel = true` keeps `resolveModel` pure (no
// analytics I/O).

const mockSdk = bootstrapMockSdk("modes-mock-sdk-", SESSION_MOCK_SDK_SOURCE);
after(() => mockSdk.cleanup());

const __require = createRequire(import.meta.url);
const __singlePath = path.resolve("harness/tools/subagent/single.ts");
const { executeSingleTask } = __require(__singlePath) as typeof import("../single.js");

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
beforeEach(() => { resetFairSelectionBags(); });
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
const noOpDetails = (results: any[]) => ({ mode: "single" as const, agentScope: "user" as const, projectAgentsDir: null, results });

function makeSingleTaskArgs(
	overrides: Partial<Parameters<typeof executeSingleTask>[0]>,
): Parameters<typeof executeSingleTask>[0] {
	return {
		params: { agent: "worker", task: "do work" },
		ctx: makeCtx(),
		agents: makeAgents(),
		runtimeCtx: { depth: 0, trail: [] },
		makeDetails: noOpDetails,
		onUpdate: undefined,
		signal: noSignal(),
		selectionCtx: selCtx(),
		toolCallId: "t1",
		parentUiBridge: undefined,
		parentSessionId: undefined,
		allToolNames: undefined,
		...overrides,
	};
}

/** Deterministic retry clock: timers resolve immediately when advanced by 0. */
class FakeClock {
	nowMs = 0;
	now(): number { return this.nowMs; }
	setTimer(_ms: number): { promise: Promise<void>; cancel: () => void } {
		return { promise: Promise.resolve(), cancel: () => {} };
	}
}

// --- executeSingleTask ------------------------------------------------------

test("executeSingleTask: success returns the final assistant output", async () => {
	setMockBehavior(successBehavior("all done"));
	const r: any = await executeSingleTask(makeSingleTaskArgs({
		params: { agent: "worker", task: "do work" },
		ctx: makeCtx(),
		selectionCtx: selCtx(),
		toolCallId: "t1",
	}));
	assert.equal(r.isError, undefined);
	assert.equal(r.content[0].text, "all done");
	assert.equal(r.details.mode, "single");
	assert.equal(r.details.results.length, 1);
	assert.equal(r.details.results[0].exitCode, 0);
	assert.equal(r.details.results[0].model, "m");
	assert.equal(r.details.results[0].family, "m", "unregistered effective model falls back to its model id");
	assert.equal(r.details.results[0].promptHash, hashDelegatedPrompt("do work"));
	assert.equal(r.details.results[0].requestedBucket, "medium");
	assert.equal(r.details.results[0].bucket, "medium");
	assert.equal(r.details.results[0].bucketDowngraded, false);
	assert.equal(r.details.results[0].parentToolCallId, "t1");
});

test("executeSingleTask: error result returns isError with 'Agent <stopReason>: <message>'", async () => {
	setMockBehavior({ onPrompt: async (emit: any) => { emit(messageEnd("partial", "error")); } });
	const r: any = await executeSingleTask(makeSingleTaskArgs({
		params: { agent: "worker", task: "do work" },
		ctx: makeCtx(),
		selectionCtx: selCtx(),
		toolCallId: "t1",
	}));
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /Agent error: partial/);
	assert.equal(r.details.results[0].exitCode, 1);
	assert.equal(r.details.results[0].stopReason, "error");
});

test("executeSingleTask: trail loop short-circuits before runSingleAgent", async () => {
	let called = false;
	setMockBehavior({ onPrompt: async () => { called = true; } });
	await assert.rejects(
		() => executeSingleTask(makeSingleTaskArgs({
			params: { agent: "worker", task: "do work" },
			ctx: makeCtx(),
			runtimeCtx: { depth: 0, trail: ["worker", "worker"] },
			selectionCtx: selCtx(),
			toolCallId: "t1",
		})),
		/Trail loop detected: agent "worker"/,
	);
	assert.equal(called, false, "trail loop must not reach runSingleAgent");
});

test("executeSingleTask: an unclassified task/model error is not replayed on another model", async () => {
	// A non-zero exit alone is not retry-safe. Without a transient provider
	// classification, failover could duplicate prose or external tool effects.
	let attempts = 0;
	setMockBehavior({ onPrompt: async (emit: any) => { attempts++; emit(messageEnd("partial", "error")); } });
	const r: any = await executeSingleTask(makeSingleTaskArgs({
		params: { agent: "worker", task: "do work" },
		ctx: makeCtx(),
		selectionCtx: selCtx({ alwaysParentModel: false, bucketAssignments: {} }),
		toolCallId: "t1",
	}));
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
		{ id: "model-a", provider: "provider-a" },
		{ id: "model-b", provider: "provider-b" },
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
	const clock = new FakeClock();
	try {
		const response: any = await executeSingleTask(makeSingleTaskArgs({
			params: { agent: "worker", task: "do work", bucket: "medium" },
			ctx: ctx,
			selectionCtx: selCtx({ alwaysParentModel: false, fallbackOnProviderFailure: true, bucketAssignments: { small: [], medium: assignedModels("model-a", "model-b"), frontier: [] }, registryModels: models }),
			toolCallId: "t-retry",
			_internal: { clock },
		}));

		assert.equal(response.isError, undefined);
		assert.equal(response.content[0].text, "recovered");
		assert.equal(attempts, 2);
		assert.equal(response.details.results[0].retryCount, 1);
		assert.equal(response.details.results[0].failedModel, "model-a");
		assert.equal(response.details.results[0].selectedModel, "model-b");
		const records = response.details.results[0].attemptRecords;
		assert.equal(records?.length, 2);
		assert.equal(records?.[0]?.attemptId, response.details.results[0].attemptRecords?.[0]?.attemptId);
		assert.equal(records?.[0]?.model, "model-a");
		assert.equal(records?.[0]?.provider, "provider-a");
		assert.equal(records?.[0]?.outcome, "failure");
		assert.equal(records?.[1]?.model, "model-b");
		assert.equal(records?.[1]?.provider, "provider-b");
		assert.equal(records?.[1]?.outcome, "success");
		assert.equal(records?.[1]?.backoffMs, 1000);
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
				// Tool-call argument generation is countable live output but not a side
				// effect, so this transport failure remains replay-safe. The second
				// burst schedules the 20fps trailing update.
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
		{ id: "model-a", provider: "provider-a" },
		{ id: "model-b", provider: "provider-b" },
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
		const response: any = await executeSingleTask(makeSingleTaskArgs({
			params: { agent: "worker", task: "do work", bucket: "medium" },
			ctx: ctx,
			onUpdate: (update: any) => publishedModels.push(update.details.results[0]?.selectedModel),
			selectionCtx: selCtx({ alwaysParentModel: false, fallbackOnProviderFailure: true, bucketAssignments: { small: [], medium: assignedModels("model-a", "model-b"), frontier: [] }, registryModels: models }),
			toolCallId: "t-retry-terminal-fence",
			_internal: { clock: new FakeClock() },
		}));
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
	const response: any = await executeSingleTask(makeSingleTaskArgs({
		params: { agent: "worker", task: "do work", bucket: "medium" },
		ctx: ctx,
		selectionCtx: selCtx({ alwaysParentModel: false, fallbackOnProviderFailure: true, bucketAssignments: { small: [], medium: assignedModels("bucket-model"), frontier: [] }, registryModels: models }),
		toolCallId: "t-exhausted",
		_internal: { clock: new FakeClock() },
	}));
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
	const response: any = await executeSingleTask(makeSingleTaskArgs({
		params: { agent: "worker", task: "do work", bucket: "medium" },
		ctx: makeCtx(),
		selectionCtx: selCtx({ alwaysParentModel: false, fallbackOnProviderFailure: false, bucketAssignments: { small: [], medium: assignedModels("active-model", "other-model"), frontier: [] } }),
		toolCallId: "t-no-retry",
	}));
	assert.equal(response.isError, true);
	assert.equal(attempts, 1);
	assert.equal(response.details.results[0].retryCount, undefined);
});

test("executeSingleTask: parent abort is terminal and never starts a fallback model attempt", async () => {
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
		bucketAssignments: { small: [], medium: assignedModels("model-a", "model-b"), frontier: [] },
	});

	const r: any = await executeSingleTask(makeSingleTaskArgs({
		params: { agent: "worker", task: "do work", bucket: "medium" },
		ctx: ctx,
		signal: controller.signal,
		selectionCtx: selection,
		toolCallId: "t-abort",
	}));

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

test("executeSingleTask stamps the bare tool-call id (single result -> bare id)", async () => {
	const bridge = createStampCaptureBridge();
	setMockBehavior({ onPrompt: async (emit: any) => {
		const proxy = (globalThis as any).__MOCK_PROXIES__.at(-1);
		await proxy.select("q", ["a"]);
		emit(messageEnd("ok", "completed"));
	} });
	await executeSingleTask(makeSingleTaskArgs({
		params: { agent: "worker", task: "s" },
		ctx: makeCtx(),
		selectionCtx: selCtx(),
		toolCallId: "callD",
		parentUiBridge: bridge,
	}));
	assert.equal(bridge.calls.select[0].opts.subagentCallId, "callD");

	const capturedProxy = (globalThis as any).__MOCK_PROXIES__[0];
	assert.equal(await capturedProxy.select("late", ["x"]), undefined);
	assert.equal(bridge.calls.select.length, 1, "a terminal session's captured proxy stays fenced");
});
