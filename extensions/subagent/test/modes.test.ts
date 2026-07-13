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
import {
	formatParallelResult,
	formatChainSuccessResult,
	buildChainStepFailureResponse,
	checkChainPreFlight,
} from "../src/modes.js";
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

function makeDetails(mode: "single" | "parallel" | "chain", results: SingleResult[]): SubagentDetails {
	return { mode, agentScope: "user", projectAgentsDir: null, results };
}

function assistantMsg(text: string): any {
	return { role: "assistant", content: [{ type: "text", text }], model: "m" };
}

type Step = { agent: string; task: string };

// ---------------------------------------------------------------------------
// formatParallelResult
// ---------------------------------------------------------------------------

test("formatParallelResult: summarizes N results with success count", () => {
	const results = [
		result({ agent: "a", exitCode: 0, messages: [assistantMsg("out-a")] }),
		result({ agent: "b", exitCode: 0, messages: [assistantMsg("out-b")] }),
		result({ agent: "c", exitCode: 1, stderr: "boom", messages: [assistantMsg("partial-c")] }),
	];
	const r: any = formatParallelResult(results, makeDetails);
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /^Parallel: 2\/3 succeeded/);
	assert.ok(r.content[0].text.includes("[a] completed: out-a"));
	assert.ok(r.content[0].text.includes("[b] completed: out-b"));
	assert.ok(r.content[0].text.includes("[c] failed:"));
	assert.ok(r.content[0].text.includes("boom"));
	assert.deepEqual(r.details.results, results);
	assert.equal(r.details.mode, "parallel");
});

test("formatParallelResult: isError false when all succeed", () => {
	const results = [result({ agent: "a", exitCode: 0 }), result({ agent: "b", exitCode: 0 })];
	const r: any = formatParallelResult(results, makeDetails);
	assert.equal(r.isError, false);
	assert.match(r.content[0].text, /Parallel: 2\/2 succeeded/);
});

test("formatParallelResult: empty results -> 0/0 succeeded and not an error", () => {
	const r: any = formatParallelResult([], makeDetails);
	assert.match(r.content[0].text, /Parallel: 0\/0 succeeded/);
	assert.equal(r.isError, false);
});

test("formatParallelResult: failed task with no stderr/output shows '(no output)'", () => {
	const results = [result({ agent: "a", exitCode: 1, messages: [], stderr: "" })];
	const r: any = formatParallelResult(results, makeDetails);
	assert.ok(r.content[0].text.includes("[a] failed: (no output)"));
});

// ---------------------------------------------------------------------------
// formatChainSuccessResult
// ---------------------------------------------------------------------------

test("formatChainSuccessResult: content is the final output of the last result", () => {
	const results = [
		result({ agent: "a", messages: [assistantMsg("first")] }),
		result({ agent: "b", messages: [assistantMsg("final answer")] }),
	];
	const r: any = formatChainSuccessResult(results, makeDetails);
	assert.equal(r.content[0].text, "final answer");
	assert.equal(r.isError, undefined);
	assert.equal(r.details.mode, "chain");
	assert.deepEqual(r.details.results, results);
});

test("formatChainSuccessResult: '(no output)' when last result has no assistant text", () => {
	const results = [result({ agent: "a", messages: [] })];
	const r: any = formatChainSuccessResult(results, makeDetails);
	assert.equal(r.content[0].text, "(no output)");
});

// ---------------------------------------------------------------------------
// buildChainStepFailureResponse
// ---------------------------------------------------------------------------

test("buildChainStepFailureResponse: undefined when result is not an error", () => {
	const r = buildChainStepFailureResponse(0, { agent: "a", task: "t" } as Step, result({ exitCode: 0 }), [], makeDetails);
	assert.equal(r, undefined);
});

test("buildChainStepFailureResponse: includes 1-based step index and error message", () => {
	const res = result({ exitCode: 1, errorMessage: "kaboom" });
	const collected: SingleResult[] = [];
	const r: any = buildChainStepFailureResponse(2, { agent: "worker", task: "t" } as Step, res, collected, makeDetails);
	assert.ok(r);
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /Chain stopped at step 3 \(worker\): kaboom/);
	assert.equal(r.details.mode, "chain");
	assert.deepEqual(r.details.results, collected);
});

test("buildChainStepFailureResponse: step index is 1-based from the 0-based input", () => {
	const r: any = buildChainStepFailureResponse(0, { agent: "a", task: "t" } as Step, result({ exitCode: 1, stderr: "err" }), [], makeDetails);
	assert.match(r.content[0].text, /step 1 /);
});

test("buildChainStepFailureResponse: prefers errorMessage, falls back to stderr then final output", () => {
	const viaStderr: any = buildChainStepFailureResponse(
		0, { agent: "a", task: "t" } as Step,
		result({ exitCode: 1, stderr: "std-err", messages: [assistantMsg("out")] }),
		[], makeDetails,
	);
	assert.ok(viaStderr.content[0].text.includes("std-err"));

	const viaOutput: any = buildChainStepFailureResponse(
		0, { agent: "a", task: "t" } as Step,
		result({ exitCode: 1, messages: [assistantMsg("final-out")] }),
		[], makeDetails,
	);
	assert.ok(viaOutput.content[0].text.includes("final-out"));
});

test("buildChainStepFailureResponse: aborted stopReason also counts as failure", () => {
	const r: any = buildChainStepFailureResponse(
		0, { agent: "a", task: "t" } as Step,
		result({ exitCode: 0, stopReason: "aborted", errorMessage: "user aborted" }),
		[], makeDetails,
	);
	assert.ok(r, "aborted stopReason should be treated as a failure");
	assert.match(r.content[0].text, /user aborted/);
});

// ---------------------------------------------------------------------------
// checkChainPreFlight
// ---------------------------------------------------------------------------

function preFlightArgs(over: Partial<{ trail: string[]; checkSessionLimit: () => string | undefined; results: SingleResult[] }> = {}) {
	return {
		runtimeCtx: { depth: 0, trail: over.trail ?? [] },
		checkSessionLimit: over.checkSessionLimit ?? (() => undefined),
		results: over.results ?? [],
		makeDetails,
	};
}

test("checkChainPreFlight: no loop and no session limit -> undefined (pass-through)", () => {
	const results: SingleResult[] = [];
	const r = checkChainPreFlight(0, { agent: "a", task: "t" } as Step, "do thing", preFlightArgs({ results }));
	assert.equal(r, undefined);
	assert.equal(results.length, 0, "no error result pushed on pass-through");
});

test("checkChainPreFlight: trail loop -> error response mentioning the agent and step", () => {
	const results: SingleResult[] = [];
	const r: any = checkChainPreFlight(
		1,
		{ agent: "loopy", task: "t" } as Step,
		"do thing",
		preFlightArgs({ trail: ["loopy", "loopy"], results }),
	);
	assert.ok(r);
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /Chain stopped at step 2: trail loop for agent "loopy"/);
	assert.equal(results.length, 1, "error result pushed into results");
	assert.equal(results[0].agent, "loopy");
	assert.ok(results[0].errorMessage?.includes("Trail loop detected"));
	assert.equal(results[0].step, 2);
	assert.equal(r.details.mode, "chain");
});

test("checkChainPreFlight: session limit -> error response includes the limit message", () => {
	const results: SingleResult[] = [];
	const r: any = checkChainPreFlight(
		3,
		{ agent: "a", task: "t" } as Step,
		"do thing",
		preFlightArgs({ checkSessionLimit: () => "session limit reached", results }),
	);
	assert.ok(r);
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /Chain stopped at step 4: session limit reached/);
	assert.equal(results.length, 1);
	assert.equal(results[0].errorMessage, "session limit reached");
	assert.equal(results[0].step, 4);
});

test("checkChainPreFlight: trail loop takes precedence over session limit", () => {
	const results: SingleResult[] = [];
	const r: any = checkChainPreFlight(
		0,
		{ agent: "dup", task: "t" } as Step,
		"x",
		preFlightArgs({ trail: ["dup", "dup"], checkSessionLimit: () => "should-not-fire", results }),
	);
	assert.match(r.content[0].text, /trail loop/);
	assert.doesNotMatch(r.content[0].text, /should-not-fire/);
});

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
const { executeSingleMode, executeParallelMode, executeChainMode } = __require(__modesPath) as typeof import("../src/modes.js");
// Loose aliases so the many-arg orchestration calls read cleanly.
const execSingle = executeSingleMode as any;
const execParallel = executeParallelMode as any;
const execChain = executeChainMode as any;

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
	const r: any = await execSingle(
		{ agent: "worker", task: "do work" }, makeCtx(), makeAgents(),
		() => undefined, { depth: 0, trail: ["worker", "worker"] }, noOpDetails, undefined, noSignal(), selCtx(), "t1", undefined,
	);
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /Trail loop detected: agent "worker"/);
	assert.equal(r.details.results.length, 0);
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

test("unclassified provider error does not retry because failure metadata is no longer attached", async () => {
	let attempts = 0;
	setMockBehavior({
		onPrompt: async (emit: any) => {
			attempts++;
			if (attempts === 1) {
				const error = Object.assign(new Error("provider timed out"), { code: "ETIMEDOUT" });
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
	const response: any = await execSingle(
		{ agent: "worker", task: "do work", bucket: "medium" }, ctx, makeAgents(),
		() => undefined, { depth: 0, trail: [] }, noOpDetails, undefined, noSignal(),
		selCtx({ alwaysParentModel: false, bucketAssignments: { small: [], medium: ["model-a", "model-b"], frontier: [] } }),
		"t-retry", undefined,
	);
	assert.equal(response.isError, true);
	assert.equal(attempts, 1, "runner no longer attaches retryable/replaySafety metadata, so failover is not triggered");
	assert.equal(response.details.results[0].retryCount, undefined);
	assert.equal(response.details.results[0].failedModel, undefined);
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
	assert.equal(r.details.results[0].stopReason, undefined);
	assert.match(r.details.results[0].errorMessage ?? "", /Subagent aborted \(while waiting for model response\)/);
	assert.equal(r.details.results[0].retryCount, undefined);
});

// --- executeParallelMode ----------------------------------------------------

test("executeParallelMode: too many tasks returns isError without running", async () => {
	const previousMax = process.env.PIE_SUBAGENT_MAX_PARALLEL_TASKS;
	process.env.PIE_SUBAGENT_MAX_PARALLEL_TASKS = "4";
	try {
		let called = false;
		setMockBehavior({ onPrompt: async () => { called = true; } });
		const tasks = Array.from({ length: 9 }, () => ({ agent: "worker", task: "t" }));
		const r: any = await execParallel(
			{ tasks }, makeCtx(), makeAgents(), () => undefined, { depth: 0, trail: [] }, noOpDetails, undefined, noSignal(), selCtx(), "t1", undefined,
		);
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /Too many parallel tasks \(9\)\. Max is 4\./);
		assert.equal(called, false);
	} finally {
		if (previousMax === undefined) delete process.env.PIE_SUBAGENT_MAX_PARALLEL_TASKS;
		else process.env.PIE_SUBAGENT_MAX_PARALLEL_TASKS = previousMax;
	}
});

test("executeParallelMode: all tasks succeed -> not an error", async () => {
	setMockBehavior(successBehavior("done"));
	const r: any = await execParallel(
		{ tasks: [{ agent: "worker", task: "a" }, { agent: "worker", task: "b" }] }, makeCtx(), makeAgents(),
		() => undefined, { depth: 0, trail: [] }, noOpDetails, undefined, noSignal(), selCtx(), "t1", undefined,
	);
	assert.equal(r.isError, false);
	assert.match(r.content[0].text, /Parallel: 2\/2 succeeded/);
	assert.equal(r.details.mode, "parallel");
	assert.equal(r.details.results.length, 2);
	assert.equal(r.details.results[0].exitCode, 0);
});

test("executeParallelMode: partial failure -> isError and onUpdate reports progress", async () => {
	const updates: any[] = [];
	setMockBehavior({
		onPrompt: async (emit: any, prompt: string) => {
			if (prompt.includes("fail")) emit(messageEnd("partial", "error"));
			else emit(messageEnd("ok", "completed"));
		},
	});
	const r: any = await execParallel(
		{ tasks: [{ agent: "worker", task: "ok-task" }, { agent: "worker", task: "fail-task" }] }, makeCtx(), makeAgents(),
		() => undefined, { depth: 0, trail: [] }, noOpDetails, (u: any) => updates.push(u), noSignal(), selCtx(), "t1", undefined,
	);
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /Parallel: 1\/2 succeeded/);
	assert.ok(updates.length >= 1, "onUpdate fired during the parallel run");
	assert.deepEqual(
		updates[0].details.results.map((result: any) => [result.activityPhase, result.activityDetail]),
		[
			["queued", "waiting for parallel worker slot"],
			["queued", "waiting for parallel worker slot"],
		],
		"the first update must replace host-reconstructed placeholders before workers start",
	);
	assert.ok(
		updates.some((u) => u.content[0].text.includes("done") && u.content[0].text.includes("running")),
		"a running-progress update was emitted",
	);
	assert.equal(r.details.mode, "parallel");
});

test("executeParallelMode: per-task session limit creates an error result", async () => {
	let called = false;
	setMockBehavior({ onPrompt: async () => { called = true; } });
	const r: any = await execParallel(
		{ tasks: [{ agent: "worker", task: "a" }] }, makeCtx(), makeAgents(),
		() => "session limit reached", { depth: 0, trail: [] }, noOpDetails, undefined, noSignal(), selCtx(), "t1", undefined,
	);
	assert.equal(r.isError, true);
	assert.ok(r.content[0].text.includes("[worker] failed:"));
	assert.ok(r.content[0].text.includes("session limit reached"));
	assert.equal(called, false, "session limit short-circuits before runSingleAgent");
});

test("executeParallelMode: per-task trail loop creates an error result", async () => {
	let called = false;
	setMockBehavior({ onPrompt: async () => { called = true; } });
	const r: any = await execParallel(
		{ tasks: [{ agent: "worker", task: "a" }] }, makeCtx(), makeAgents(),
		() => undefined, { depth: 0, trail: ["worker", "worker"] }, noOpDetails, undefined, noSignal(), selCtx(), "t1", undefined,
	);
	assert.equal(r.isError, true);
	assert.ok(r.content[0].text.includes("Trail loop detected"));
	assert.equal(called, false);
});

// --- executeChainMode -------------------------------------------------------

test("executeChainMode: all steps succeed -> final output of last step", async () => {
	setMockBehavior({
		onPrompt: async (emit: any, prompt: string) => {
			const text = prompt.includes("first") ? "first-out" : "second-out";
			emit(messageEnd(text, "completed"));
		},
	});
	const r: any = await execChain(
		{ chain: [{ agent: "worker", task: "first" }, { agent: "worker", task: "then second" }] }, makeCtx(), makeAgents(),
		() => undefined, { depth: 0, trail: [] }, noOpDetails, undefined, noSignal(), selCtx(), "t1", undefined,
	);
	assert.equal(r.isError, undefined);
	assert.equal(r.content[0].text, "second-out");
	assert.equal(r.details.mode, "chain");
	assert.equal(r.details.results.length, 2);
});

test("executeChainMode: substitutes {previous} with the prior step output", async () => {
	const seenPrompts: string[] = [];
	setMockBehavior({
		onPrompt: async (emit: any, prompt: string) => {
			seenPrompts.push(prompt);
			const text = prompt.includes("FIRST") ? "FIRST-RESULT" : "done";
			emit(messageEnd(text, "completed"));
		},
	});
	await execChain(
		{ chain: [{ agent: "worker", task: "FIRST" }, { agent: "worker", task: "use [{previous}] now" }] }, makeCtx(), makeAgents(),
		() => undefined, { depth: 0, trail: [] }, noOpDetails, undefined, noSignal(), selCtx(), "t1", undefined,
	);
	assert.equal(seenPrompts.length, 2);
	assert.ok(seenPrompts[1].includes("FIRST-RESULT"), "previous output substituted into step 2");
	assert.ok(!seenPrompts[1].includes("{previous}"), "{previous} placeholder removed");
});

test("executeChainMode: failing step stops the chain with an error", async () => {
	setMockBehavior({
		onPrompt: async (emit: any, prompt: string) => {
			if (prompt.includes("boom")) emit(messageEnd("partial", "error"));
			else emit(messageEnd("ok", "completed"));
		},
	});
	const r: any = await execChain(
		{ chain: [{ agent: "worker", task: "first" }, { agent: "worker", task: "boom" }, { agent: "worker", task: "third" }] }, makeCtx(), makeAgents(),
		() => undefined, { depth: 0, trail: [] }, noOpDetails, undefined, noSignal(), selCtx(), "t1", undefined,
	);
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /Chain stopped at step 2 \(worker\): partial/);
	assert.equal(r.details.mode, "chain");
	assert.equal(r.details.results.length, 2, "chain stopped before step 3");
});

test("executeChainMode: trail loop in pre-flight stops the chain", async () => {
	let called = false;
	setMockBehavior({ onPrompt: async () => { called = true; } });
	const r: any = await execChain(
		{ chain: [{ agent: "worker", task: "first" }] }, makeCtx(), makeAgents(),
		() => undefined, { depth: 0, trail: ["worker", "worker"] }, noOpDetails, undefined, noSignal(), selCtx(), "t1", undefined,
	);
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /Chain stopped at step 1: trail loop for agent "worker"/);
	assert.equal(r.details.results.length, 1);
	assert.equal(r.details.results[0].step, 1);
	assert.equal(called, false, "trail loop short-circuits before runSingleAgent");
});

test("executeChainMode: session limit in pre-flight stops the chain", async () => {
	let called = false;
	setMockBehavior({ onPrompt: async () => { called = true; } });
	const r: any = await execChain(
		{ chain: [{ agent: "worker", task: "first" }] }, makeCtx(), makeAgents(),
		() => "session limit reached", { depth: 0, trail: [] }, noOpDetails, undefined, noSignal(), selCtx(), "t1", undefined,
	);
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /Chain stopped at step 1: session limit reached/);
	assert.equal(called, false);
});

test("executeChainMode: onUpdate mirrors partial results into the chain view", async () => {
	const updates: any[] = [];
	setMockBehavior(successBehavior("ok"));
	await execChain(
		{ chain: [{ agent: "worker", task: "first" }] }, makeCtx(), makeAgents(),
		() => undefined, { depth: 0, trail: [] }, noOpDetails, (u: any) => updates.push(u), noSignal(), selCtx(), "t1", undefined,
	);
	assert.ok(updates.length >= 1, "onUpdate fired");
	assert.equal(updates[0].details.mode, "chain");
});

// --- subagentCallId stamping (mirrors the webview SubagentCallContext) --------
// The webview renders a subagent's ask_user inline by matching the request's
// subagentCallId against the enclosing tool-call id: bare `id` when a single
// result renders (results.length <= 1), `${id}:${index}` when multiple results
// render (results.length > 1). modes.ts must stamp the SAME id or the inline
// prompt never matches and the subagent hangs. These tests pin the stamping by
// capturing the ParentExtensionUIBridgeProxy each runSingleAgent constructs
// (via the mock SDK's setUIContext sink) and reading the stamped id back through
// a mock parent bridge.

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

async function capturedSubagentCallIds(bridge: ReturnType<typeof createStampCaptureBridge>): Promise<string[]> {
	const proxies: any[] = (globalThis as any).__MOCK_PROXIES__ || [];
	const ids: string[] = [];
	for (const p of proxies) {
		// proxy.select delegates to bridge.select, recording opts.subagentCallId.
		await p.select("q", ["a"]);
		ids.push(bridge.calls.select[bridge.calls.select.length - 1].opts.subagentCallId);
	}
	return ids;
}

test("executeSingleMode stamps the bare tool-call id (single result -> bare id)", async () => {
	setMockBehavior(successBehavior("ok"));
	const bridge = createStampCaptureBridge();
	await execSingle(
		{ agent: "worker", task: "s" }, makeCtx(), makeAgents(),
		() => undefined, { depth: 0, trail: [] }, noOpDetails, undefined, noSignal(), selCtx(), "callD", bridge,
	);
	const ids = await capturedSubagentCallIds(bridge);
	assert.deepEqual(ids, ["callD"]);
});

test("executeChainMode stamps bare id for step 0 and `${id}:${i}` for later steps", async () => {
	setMockBehavior(successBehavior("ok"));
	const bridge = createStampCaptureBridge();
	await execChain(
		{ chain: [{ agent: "worker", task: "s0" }, { agent: "worker", task: "s1" }, { agent: "worker", task: "s2" }] },
		makeCtx(), makeAgents(), () => undefined, { depth: 0, trail: [] }, noOpDetails, undefined, noSignal(), selCtx(), "callA", bridge,
	);
	// Chain steps run sequentially; each constructs one proxy in order.
	const ids = await capturedSubagentCallIds(bridge);
	assert.deepEqual(ids, ["callA", "callA:1", "callA:2"]);
});

test("executeParallelMode stamps `${id}:${index}` for multi-task and bare id for single-task", async () => {
	setMockBehavior(successBehavior("ok"));

	// Multi-task (results.length > 1) -> webview uses `${id}:${index}`.
	const bridgeMulti = createStampCaptureBridge();
	await execParallel(
		{ tasks: [{ agent: "worker", task: "a" }, { agent: "worker", task: "b" }] },
		makeCtx(), makeAgents(), () => undefined, { depth: 0, trail: [] }, noOpDetails, undefined, noSignal(), selCtx(), "callB", bridgeMulti,
	);
	const idsMulti = (await capturedSubagentCallIds(bridgeMulti)).sort();
	assert.deepEqual(idsMulti, ["callB:0", "callB:1"]);

	// Single-task (results.length <= 1) -> webview uses bare `id`.
	(globalThis as any).__MOCK_PROXIES__ = [];
	const bridgeSingle = createStampCaptureBridge();
	await execParallel(
		{ tasks: [{ agent: "worker", task: "a" }] },
		makeCtx(), makeAgents(), () => undefined, { depth: 0, trail: [] }, noOpDetails, undefined, noSignal(), selCtx(), "callC", bridgeSingle,
	);
	const idsSingle = await capturedSubagentCallIds(bridgeSingle);
	assert.deepEqual(idsSingle, ["callC"]);
});
