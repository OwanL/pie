/**
 * Focused usage-accounting hardening tests for the subagent extension.
 *
 * Covers:
 *  - runtime provider/model is stamped from the assistant message rather than
 *    only the configured selection;
 *  - per-turn throughput samples are produced from terminal assistant message
 *    usage and SDK event timestamps;
 *  - failed retry attempts contribute their usage to the final returned result
 *    and to their attempt records;
 *  - depth ≥ 2 nested subagent usage is rolled into parent usage exactly once;
 *  - reported usage.cost is preserved through accumulation and rollup.
 */

import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { AgentConfig } from "../agents.js";
import type { SingleResult } from "../types.js";

// -----------------------------------------------------------------------------
// Mock SDK loader hook. Required only for importing executeSingleMode (via
// src/modes.js), whose transitive import graph reaches the pi SDK. The hook
// matches the pattern in retry.test.ts; runner tests below pass an explicit
// _internal.sdk so they are not affected by the mock session shape.
// -----------------------------------------------------------------------------
const MOCK_SDK_SOURCE = [
	"export class DefaultResourceLoader { constructor(a){ this.a = a; } async reload(){} }",
	"export const SessionManager = { inMemory(cwd){ return { cwd: cwd }; } };",
	"export function getAgentDir(){ return '.'; }",
	"export async function createAgentSession(args){",
	"  const listeners = [];",
	"  const session = {",
	"    agent: { state: { model: { id: 'session-model' } } },",
	"    extensionRunner: { setUIContext(ctx){} },",
	"    subscribe(cb){ listeners.push(cb); return () => {}; },",
	"    async prompt(p){",
	"      const b = globalThis.__MOCK_SDK_BEHAVIOR__;",
	"      if (b && b.onPrompt) { await b.onPrompt(function(ev){ for (const l of listeners) l(ev); }, p); return; }",
	"      await new Promise(function(r){});",
	"    },",
	"    async abort(){},",
	"    dispose(){}",
	"  };",
	"  return { session: session };",
	"}",
].join("\n");

const __mockSdkDir = mkdtempSync(path.join(tmpdir(), "usage-mock-sdk-"));
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
if (!(globalThis as { __PIE_SDK_HOOK_REGISTERED__?: boolean }).__PIE_SDK_HOOK_REGISTERED__) {
	(globalThis as { __PIE_SDK_HOOK_REGISTERED__?: boolean }).__PIE_SDK_HOOK_REGISTERED__ = true;
	Module.register(pathToFileURL(__hookPath));
}

const __require = createRequire(import.meta.url);
const { runSingleAgent } = __require(path.resolve("extensions/subagent/runner.js")) as typeof import("../runner.js");
const { executeSingleMode } = __require(path.resolve("extensions/subagent/src/modes.js")) as typeof import("../src/modes.js");
const execSingle = executeSingleMode as any;

// -----------------------------------------------------------------------------
// Shared test fixtures
// -----------------------------------------------------------------------------
const agentDir = mkdtempSync(path.join(tmpdir(), "usage-agents-"));
const agentsSubdir = path.join(agentDir, "agents");
mkdirSync(agentsSubdir, { recursive: true });
writeFileSync(
	path.join(agentsSubdir, "worker.md"),
	"---\nname: worker\ndescription: test agent\n---\nYou are a worker.\n",
	"utf-8",
);

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

function makeModelRegistry(models: Array<{ id: string; provider: string }>) {
	return {
		getAvailable: () => models,
		getAll: () => models,
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
	};
}

function createFakeSdk(events: Array<{ type: string;[key: string]: unknown }>) {
	const listeners: Array<(event: any) => void> = [];
	const session = {
		agent: { state: { model: { id: "session-model" } } },
		extensionRunner: { setUIContext: () => undefined },
		subscribe: (cb: (event: any) => void) => {
			listeners.push(cb);
			return () => undefined;
		},
		prompt: async (_prompt: string) => {
			for (const event of events) {
				for (const listener of listeners) listener(event);
			}
		},
		abort: async () => undefined,
		dispose: () => undefined,
	};
	const sdk = {
		createSession: async () => ({ session }),
		createResourceLoader: () => ({ reload: async () => undefined }),
		createSessionManager: () => ({}),
		getAgentDir: () => ".",
	};
	return { sdk, session };
}

function runFakeAgent(
	sdk: unknown,
	onUpdate?: (partial: any) => void,
	signal?: AbortSignal,
	modelRegistry = makeModelRegistry([{ id: "session-model", provider: "session-provider" }]),
) {
	return runSingleAgent(
		process.cwd(),
		[makeAgent()],
		"worker",
		"do work",
		undefined,
		undefined,
		signal,
		onUpdate,
		(results: SingleResult[]) => ({ mode: "single" as const, agentScope: "user" as const, projectAgentsDir: null, results }),
		modelRegistry as any,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ sdk: sdk as any, timeoutMs: 0 },
	);
}

function makeCtx(models: any[] = []) {
	return {
		cwd: process.cwd(),
		model: models[0] ?? { id: "active-model", provider: "active-provider" },
		modelRegistry: {
			getAvailable: () => models,
			getAll: () => models,
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		},
	};
}

function makeAgents(): any[] {
	return [{ name: "worker", description: "d", systemPrompt: "", source: "user", filePath: "w.md" }];
}

function selCtx(over: Record<string, unknown> = {}): any {
	return {
		modelConfig: [],
		disabledProviders: new Set(),
		allowedModelIds: undefined,
		bucketAssignments: undefined,
		alwaysParentModel: true,
		nestedAllowedBuckets: { small: true, medium: true, frontier: true },
		...over,
	};
}

const noOpDetails = (mode: any, results: any[]) => ({ mode, agentScope: "user" as const, projectAgentsDir: null, results });
const noSignal = () => new AbortController().signal;

function syntheticResult(over: Partial<SingleResult>): SingleResult {
	const now = Date.now();
	return {
		agent: "worker",
		agentSource: "user",
		task: "do work",
		exitCode: 1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		startedAt: now,
		completedAt: now,
		...over,
	} as SingleResult;
}

class ImmediateClock {
	nowMs = 0;
	now(): number { return this.nowMs; }
	setTimer(_ms: number): { promise: Promise<void>; cancel: () => void } {
		return { promise: Promise.resolve(), cancel: () => {} };
	}
}

const ENV_KEYS = ["PIE_SUBAGENT_MAX_INFLIGHT", "PIE_SUBAGENT_MAX_TREE_SESSIONS", "PI_CODING_AGENT_DIR"];
const savedEnv: Record<string, string | undefined> = {};
test.before(() => {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "10";
	process.env.PIE_SUBAGENT_MAX_TREE_SESSIONS = "10";
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
test.after(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

// -----------------------------------------------------------------------------
// 1. Runtime provider/model stamping
// -----------------------------------------------------------------------------
test("runSingleAgent stamps runtime provider and model from the assistant message", async () => {
	const registry = makeModelRegistry([
		{ id: "runtime-model", provider: "runtime-provider" },
	]);
	const { sdk } = createFakeSdk([
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.0015 } },
				model: "runtime-model",
				stopReason: "completed",
			},
		},
	]);

	const result = await runFakeAgent(sdk, undefined, undefined, registry);

	assert.equal(result.exitCode, 0);
	assert.equal(result.model, "runtime-model", "model must be the runtime model, not the configured selection");
	assert.equal(result.provider, "runtime-provider", "provider must be derived from the runtime model");
	assert.equal(result.usage.input, 10);
	assert.equal(result.usage.output, 5);
	assert.equal(result.usage.cost, 0.0015);
});

test("runSingleAgent never lets a same-id registry collision override the runtime provider", async () => {
	const registry = makeModelRegistry([
		{ id: "shared-model", provider: "openai-codex" },
		{ id: "shared-model", provider: "github-copilot" },
	]);
	const { sdk } = createFakeSdk([{
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.01 } },
			model: "shared-model",
			provider: "openai-codex",
			stopReason: "completed",
		},
	}]);

	const result = await runFakeAgent(sdk, undefined, undefined, registry);
	assert.equal(result.provider, "openai-codex");
	assert.equal(result.turnThroughputSamples?.[0]?.provider, "openai-codex");
});

// -----------------------------------------------------------------------------
// 2. Per-turn throughput samples
// -----------------------------------------------------------------------------
test("runSingleAgent produces per-turn throughput samples from terminal assistant usage and timestamps", async () => {
	const registry = makeModelRegistry([{ id: "fast-model", provider: "fast-provider" }]);
	const start = 1_000_000;
	const end = 1_000_123;
	const { sdk } = createFakeSdk([
		{
			type: "message_start",
			message: { role: "assistant", timestamp: start },
		},
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				usage: { input: 4, output: 16, cost: { total: 0.0001 } },
				model: "fast-model",
				stopReason: "completed",
				timestamp: end,
			},
		},
	]);

	const result = await runFakeAgent(sdk, undefined, undefined, registry);

	assert.equal(result.exitCode, 0);
	assert.ok(result.turnThroughputSamples, "samples array must exist");
	assert.equal(result.turnThroughputSamples!.length, 1);
	const sample = result.turnThroughputSamples![0];
	assert.equal(sample.outputTokens, 16);
	assert.equal(sample.generationDurationMs, 123);
	assert.equal(sample.status, "completed");
	assert.equal(sample.modelId, "fast-model");
	assert.equal(sample.endedAt, new Date(end).toISOString());
});

// -----------------------------------------------------------------------------
// 3. Nested subagent usage rollup (depth ≥ 2)
// -----------------------------------------------------------------------------
test("runSingleAgent preserves depth >= 2 results without mixing child usage into the parent model", async () => {
	const registry = makeModelRegistry([{ id: "parent-model", provider: "parent-provider" }]);
	const childResult: SingleResult = syntheticResult({
		exitCode: 0,
		stopReason: "completed",
		model: "child-model",
		provider: "child-provider",
		usage: { input: 20, output: 10, cacheRead: 2, cacheWrite: 1, cost: 0.003, contextTokens: 30, turns: 1 },
		messages: [],
	});
	const grandchildResult: SingleResult = syntheticResult({
		exitCode: 0,
		stopReason: "completed",
		model: "grandchild-model",
		provider: "grandchild-provider",
		usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 8, turns: 1 },
		messages: [],
	});
	childResult.messages.push({
		role: "toolResult",
		toolName: "subagent",
		details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [grandchildResult] },
	} as any);

	const { sdk } = createFakeSdk([
		{
			type: "message_end",
			message: {
				role: "toolResult",
				toolName: "subagent",
				details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [childResult] },
			},
		},
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "parent done" }],
				usage: { input: 7, output: 3, cost: { total: 0.0002 } },
				model: "parent-model",
				stopReason: "completed",
			},
		},
	]);

	const result = await runFakeAgent(sdk, undefined, undefined, registry);

	assert.equal(result.exitCode, 0);
	assert.equal(result.usage.input, 7);
	assert.equal(result.usage.output, 3);
	assert.equal(result.usage.cacheRead, 0);
	assert.equal(result.usage.cacheWrite, 0);
	assert.equal(result.usage.cost, 0.0002);
	assert.equal(result.usage.contextTokens, 0);
	assert.equal(result.usage.turns, 1);
	const nestedToolResult = result.messages.find((message) => message.role === "toolResult") as any;
	assert.equal(nestedToolResult.details.results[0].usage.input, 20);
	assert.equal(nestedToolResult.details.results[0].messages[0].details.results[0].usage.input, 5);
});

// -----------------------------------------------------------------------------
// 4. Failed retry attempt usage preservation
// -----------------------------------------------------------------------------
test("executeSingleMode accumulates usage from two retry attempts into the final result and attempt records", async () => {
	const models = [
		{ id: "model-a", provider: "provider-a" },
		{ id: "model-b", provider: "provider-b" },
	];
	const clock = new ImmediateClock();
	const attempts: string[] = [];
	const liveUsages: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number }> = [];
	const response: any = await execSingle(
		{ agent: "worker", task: "do work", bucket: "medium" },
		makeCtx(models),
		makeAgents(),
		() => undefined,
		{ depth: 0, trail: [] },
		noOpDetails,
		(partial: any) => {
			const usage = partial.details?.results?.[0]?.usage;
			if (usage) liveUsages.push({
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
			});
		},
		noSignal(),
		selCtx({
			alwaysParentModel: false,
			fallbackOnProviderFailure: true,
			bucketAssignments: { small: [], medium: ["model-a", "model-b"], frontier: [] },
			registryModels: models,
		}),
		"t-usage-accum",
		undefined,
		undefined,
		undefined,
		{
			clock,
			runAttempt: (resolved: any, _attemptId: string, onAttemptUpdate?: (partial: any) => void) => {
				const model = resolved.modelOverride;
				attempts.push(model);
				// Fail every dispatched model so the bucket order (which depends on the
				// global Math.random state of other concurrent tests) does not matter.
				// The retry loop will exhaust the bucket and stop after two attempts.
				const attemptResult = syntheticResult({
					exitCode: 1,
					stopReason: "error",
					selectedModel: model,
					model,
					provider: model === "model-a" ? "provider-a" : "provider-b",
					usage: model === "model-a"
						? { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 150, turns: 1 }
						: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 15, turns: 1 },
					retryable: true,
					replaySafety: "safe",
					failureClass: "timeout",
				});
				onAttemptUpdate?.({
					content: [{ type: "text", text: "attempt running" }],
					details: noOpDetails("single", [attemptResult]),
				});
				return Promise.resolve(attemptResult);
			},
		},
	);

	assert.equal(response.isError, true);
	const result = response.details.results[0] as SingleResult;
	assert.equal(attempts.length, 2, "both models in the bucket must be attempted");
	assert.equal(result.usage.input, 110, "input must include both attempts");
	assert.equal(result.usage.output, 55, "output must include both attempts");
	assert.equal(result.usage.cost, 0.011, "cost must sum both attempts");
	assert.equal(result.usage.turns, 2, "turns must include both attempts");
	assert.equal(result.retryCount, 1);
	assert.ok(
		liveUsages.some((usage) => usage.input === 110 && usage.output === 55),
		"live retry telemetry must include usage from both attempts instead of resetting",
	);

	const records = result.attemptRecords;
	assert.equal(records?.length, 2);
	const firstModel = attempts[0];
	const secondModel = attempts[1];
	assert.equal(records?.[0].usage?.input, firstModel === "model-a" ? 100 : 10, "first attempt record must keep its own usage");
	assert.equal(records?.[1].usage?.input, secondModel === "model-a" ? 100 : 10, "second attempt record must keep its own usage");
});
