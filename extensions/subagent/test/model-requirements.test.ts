/**
 * Acceptance tests for the subagent `modelRequirements` feature
 * (extensions/subagent/README.md, "Hard model requirements").
 *
 * Covers:
 *  1. Existing calls without `modelRequirements` behave unchanged.
 *  2. Schema acceptance/rejection (see schema.test.ts).
 *  3. An image requirement filters text-only models from the requested and
 *     downgraded buckets.
 *  4. An incompatible active-model fallback produces a local error.
 *  5. "Always use parent model" plus an incompatible parent produces a local error.
 *  6. Duplicate IDs select only a provider-qualified image-capable declaration.
 *  7. Provider retry never escapes to a text-only model.
 *  8. Running, terminal, retried, and compacted results retain requirement provenance.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@mariozechner/pi-ai";
import { resolveModel, type SelectionContext } from "../src/execute.js";
import { resolveExecutionModel } from "../model-resolution.js";
import { compactSingleResult } from "../src/result-compaction.js";
import { executeSingleTask } from "../src/single.js";
import { resetFairSelectionBags } from "../bucket-selector.js";
import type { AgentConfig } from "../agents.js";
import type { ModelRequirements, SingleResult, SubagentDetails } from "../types.js";

const IMAGE_REQ: ModelRequirements = { inputKinds: ["image"] };

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "scout",
		description: "test",
		systemPrompt: "",
		source: "user",
		filePath: "scout.md",
		bucket: "medium",
		...overrides,
	};
}

interface SelOverrides extends Partial<SelectionContext> {
	requirementQualifiedModelIds?: Set<string>;
	callerModelInput?: ReadonlyArray<"text" | "image">;
}

function makeSelectionCtx(overrides: SelOverrides = {}): SelectionContext {
	return {
		modelConfig: [],
		disabledProviders: new Set(),
		allowedModelIds: undefined,
		bucketAssignments: { small: [], medium: [], frontier: [] },
		alwaysParentModel: false,
		nestedAllowedBuckets: { small: true, medium: true, frontier: true },
		...overrides,
	};
}

function model(provider: string, id: string, input: ("text" | "image")[] = ["text"]): Model<any> {
	return { provider, id, input } as Model<any>;
}

function registry(models: Model<any>[]) {
	return {
		getAvailable: () => models,
		getAll: () => models,
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
	};
}

// ============================================================
// resolveModel — hard image requirement filtering
// ============================================================

test("resolveModel: no requirement preserves current selection behaviour", async () => {
	resetFairSelectionBags();
	const ctx = makeSelectionCtx({
		bucketAssignments: { small: [], medium: ["text-only-a", "text-only-b"], frontier: [] },
	});
	const resolved = await resolveModel(makeAgent(), ctx, "parent-model", "medium");
	assert.equal(resolved.modelOverride, "text-only-a");
	assert.equal(resolved.requestedModelRequirements, undefined);
	assert.equal(resolved.modelRequirementsSatisfied, undefined);
	assert.equal(resolved.requirementDiagnostic, undefined);
});

test("resolveModel: image requirement filters text-only models from the requested bucket", async () => {
	resetFairSelectionBags();
	const ctx = makeSelectionCtx({
		modelRequirements: IMAGE_REQ,
		requirementQualifiedModelIds: new Set(["image-model"]),
		callerModelInput: ["text", "image"],
		bucketAssignments: { small: [], medium: ["text-only-model", "image-model"], frontier: [] },
	});
	const resolved = await resolveModel(makeAgent(), ctx, "parent-model", "medium");
	assert.equal(resolved.modelOverride, "image-model");
	assert.equal(resolved.bucket, "medium");
	assert.equal(resolved.selection.fallback, false);
	assert.equal(resolved.modelRequirementsSatisfied, true);
	assert.deepEqual(resolved.requestedModelRequirements, IMAGE_REQ);
	assert.equal(resolved.requirementDiagnostic, undefined);
});

test("resolveModel: image requirement walks down to a lower bucket for an image-capable model", async () => {
	resetFairSelectionBags();
	const ctx = makeSelectionCtx({
		modelRequirements: IMAGE_REQ,
		requirementQualifiedModelIds: new Set(["image-small"]),
		callerModelInput: ["text", "image"],
		bucketAssignments: { small: ["image-small"], medium: ["text-only-medium"], frontier: [] },
	});
	const resolved = await resolveModel(makeAgent(), ctx, "parent-model", "medium");
	// selectModel walks down to the small bucket (the only image-capable model).
	assert.equal(resolved.selection.bucket, "small");
	assert.equal(resolved.modelOverride, "image-small");
	assert.equal(resolved.modelRequirementsSatisfied, true);
});

test("resolveModel: incompatible active-model fallback produces a local selection error", async () => {
	resetFairSelectionBags();
	const ctx = makeSelectionCtx({
		modelRequirements: IMAGE_REQ,
		requirementQualifiedModelIds: new Set(),
		callerModelInput: ["text"],
		bucketAssignments: { small: ["text-only-small"], medium: ["text-only-medium"], frontier: [] },
	});
	const resolved = await resolveModel(makeAgent(), ctx, "parent-text-model", "medium");
	assert.equal(resolved.modelOverride, "");
	assert.equal(resolved.modelRequirementsSatisfied, false);
	assert.deepEqual(resolved.requestedModelRequirements, IMAGE_REQ);
	assert.match(resolved.requirementDiagnostic!, /No enabled image-capable model is available/);
	assert.match(resolved.requirementDiagnostic!, /"medium" subagent bucket/);
	assert.match(resolved.requirementDiagnostic!, /remove modelRequirements\.inputKinds=\["image"\]/);
});

test("resolveModel: qualified active model remains a valid fallback under the requirement", async () => {
	resetFairSelectionBags();
	const ctx = makeSelectionCtx({
		modelRequirements: IMAGE_REQ,
		requirementQualifiedModelIds: new Set(),
		callerModelInput: ["text", "image"],
		bucketAssignments: { small: [], medium: ["text-only-medium"], frontier: [] },
	});
	const resolved = await resolveModel(makeAgent(), ctx, "parent-image-model", "medium");
	assert.equal(resolved.modelOverride, "parent-image-model");
	assert.equal(resolved.selection.fallback, true);
	assert.equal(resolved.modelRequirementsSatisfied, true);
	assert.equal(resolved.requirementDiagnostic, undefined);
});

test("resolveModel: always-parent plus an incompatible parent produces a local selection error", async () => {
	resetFairSelectionBags();
	const ctx = makeSelectionCtx({
		alwaysParentModel: true,
		modelRequirements: IMAGE_REQ,
		callerModelInput: ["text"],
		bucketAssignments: { small: ["image-small"], medium: ["image-medium"], frontier: [] },
	});
	const resolved = await resolveModel(makeAgent(), ctx, "parent-text-model", "medium");
	assert.equal(resolved.modelOverride, "");
	assert.equal(resolved.modelRequirementsSatisfied, false);
	assert.match(resolved.requirementDiagnostic!, /No enabled image-capable model is available/);
});

test("resolveModel: always-parent plus a qualified parent is allowed", async () => {
	resetFairSelectionBags();
	const ctx = makeSelectionCtx({
		alwaysParentModel: true,
		modelRequirements: IMAGE_REQ,
		callerModelInput: ["text", "image"],
		bucketAssignments: { small: ["image-small"], medium: ["image-medium"], frontier: [] },
	});
	const resolved = await resolveModel(makeAgent(), ctx, "parent-image-model", "medium");
	assert.equal(resolved.modelOverride, "parent-image-model");
	assert.equal(resolved.modelRequirementsSatisfied, true);
	assert.equal(resolved.requirementDiagnostic, undefined);
});

test("resolveModel: nested-bucket exhaustion plus an incompatible parent produces a local error", async () => {
	resetFairSelectionBags();
	const ctx = makeSelectionCtx({
		modelRequirements: IMAGE_REQ,
		requirementQualifiedModelIds: new Set(),
		callerModelInput: ["text"],
		nestedAllowedBuckets: { small: false, medium: false, frontier: false },
		bucketAssignments: { small: ["image-small"], medium: ["image-medium"], frontier: ["image-frontier"] },
	});
	const resolved = await resolveModel(makeAgent(), ctx, "parent-text-model", "frontier", undefined, undefined, 1);
	assert.equal(resolved.modelOverride, "");
	assert.equal(resolved.modelRequirementsSatisfied, false);
	assert.match(resolved.requirementDiagnostic!, /No enabled image-capable model/);
	assert.match(resolved.bucketDowngradeReason!, /no bucket is allowed for nested subagents/);
});

// ============================================================
// resolveExecutionModel — duplicate-id provider qualification
// ============================================================

test("resolveExecutionModel: duplicate ids select only the provider-qualified image-capable declaration", () => {
	const models = [
		model("text-prov", "shared", ["text"]),
		model("image-prov", "shared", ["text", "image"]),
	];
	const result = resolveExecutionModel(
		registry(models),
		model("text-prov", "caller-model", ["text"]),
		"shared",
		undefined,
		undefined,
		IMAGE_REQ,
	);
	assert.equal(result.resolvedModel?.provider, "image-prov");
	assert.equal(result.resolvedModel?.id, "shared");
	assert.equal(result.diagnostic, undefined);
});

test("resolveExecutionModel: caller-provider preference honoured when the caller's declaration is image-capable", () => {
	const models = [
		model("text-prov", "shared", ["text"]),
		model("image-prov", "shared", ["text", "image"]),
	];
	const result = resolveExecutionModel(
		registry(models),
		model("image-prov", "caller-model", ["text", "image"]),
		"shared",
		undefined,
		undefined,
		IMAGE_REQ,
	);
	assert.equal(result.resolvedModel?.provider, "image-prov");
});

test("resolveExecutionModel: no qualified duplicate returns undefined with a requirement diagnostic", () => {
	const models = [model("text-prov", "shared", ["text"])];
	const result = resolveExecutionModel(
		registry(models),
		model("text-prov", "caller-model", ["text"]),
		"shared",
		undefined,
		undefined,
		IMAGE_REQ,
	);
	assert.equal(result.resolvedModel, undefined);
	assert.equal(result.actualModelId, undefined);
	assert.match(result.diagnostic!, /modelRequirements\.inputKinds/);
});

test("resolveExecutionModel: a disabled provider is never reintroduced to satisfy a requirement", () => {
	const models = [
		model("disabled-prov", "shared", ["text", "image"]),
		model("text-prov", "shared", ["text"]),
	];
	const result = resolveExecutionModel(
		registry(models),
		model("text-prov", "caller-model", ["text"]),
		"shared",
		new Set(["disabled-prov"]),
		undefined,
		IMAGE_REQ,
	);
	// The only image-capable declaration is on a disabled provider; resolution
	// must not fall back to the text-only duplicate nor to the text-only caller.
	assert.equal(result.resolvedModel, undefined);
	assert.equal(result.actualModelId, undefined);
	assert.match(result.diagnostic!, /disabled provider/);
	assert.match(result.diagnostic!, /disabled-prov/);
});

test("resolveExecutionModel: no requirement preserves caller-preference duplicate behaviour", () => {
	const models = [
		model("text-prov", "shared"),
		model("image-prov", "shared", ["text", "image"]),
	];
	const result = resolveExecutionModel(
		registry(models),
		model("text-prov", "caller-model"),
		"shared",
	);
	assert.equal(result.resolvedModel?.provider, "text-prov");
	assert.equal(result.diagnostic, undefined);
});

// ============================================================
// compactSingleResult — provenance survives compaction
// ============================================================

test("compactSingleResult retains requirement provenance and diagnostic", () => {
	const original: SingleResult = {
		agent: "scout",
		agentSource: "user",
		task: "inspect screenshot",
		exitCode: 1,
		messages: [],
		stderr: "diagnostic",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		requestedModelRequirements: IMAGE_REQ,
		modelRequirementsSatisfied: false,
		requirementDiagnostic: "No enabled image-capable model is available.",
	};
	const compact = compactSingleResult(original);
	assert.deepEqual(compact.requestedModelRequirements, IMAGE_REQ);
	assert.equal(compact.modelRequirementsSatisfied, false);
	assert.equal(compact.requirementDiagnostic, "No enabled image-capable model is available.");
});

// ============================================================
// executeSingleTask — local selection error, retry safety, provenance
// ============================================================

function makeCtx(callerModel: Model<any>): any {
	return {
		cwd: process.cwd(),
		model: callerModel,
		modelRegistry: registry([]),
		sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
	};
}

function noOpDetails(_mode: "single", results: SingleResult[]): SubagentDetails {
	return { mode: "single", agentScope: "user" as const, projectAgentsDir: null, results };
}

const noSignal = () => new AbortController().signal;

/** Deterministic retry clock: timers resolve immediately so tests don't wait. */
class ImmediateClock {
	nowMs = 0;
	now(): number { return this.nowMs; }
	setTimer(_ms: number): { promise: Promise<void>; cancel: () => void } {
		return { promise: Promise.resolve(), cancel: () => {} };
	}
}

function syntheticResult(over: Partial<SingleResult>): SingleResult {
	const now = Date.now();
	return {
		agent: "scout",
		agentSource: "user",
		task: "inspect screenshot",
		exitCode: 1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		startedAt: now,
		completedAt: now,
		...over,
	} as SingleResult;
}

const ENV_KEYS = ["PIE_SUBAGENT_MAX_INFLIGHT", "PIE_SUBAGENT_MAX_TREE_SESSIONS", "PI_CODING_AGENT_DIR"];
const savedEnv: Record<string, string | undefined> = {};
let savedRandom: () => number;

test.before(() => {
	savedRandom = Math.random;
	Math.random = () => 0;
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "10";
	process.env.PIE_SUBAGENT_MAX_TREE_SESSIONS = "10";
});
test.beforeEach(() => {
	resetFairSelectionBags();
});
test.after(() => {
	Math.random = savedRandom;
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

test("executeSingleTask: local selection error short-circuits before dispatching a child", async () => {
	const callerModel = model("parent", "parent-text-model", ["text"]);
	const selectionCtx = makeSelectionCtx({
		modelRequirements: IMAGE_REQ,
		requirementQualifiedModelIds: new Set(),
		callerModelInput: ["text"],
		bucketAssignments: { small: ["text-only-small"], medium: ["text-only-medium"], frontier: [] },
	});
	let runAttemptCalls = 0;
	const response: any = await executeSingleTask({
		params: { agent: "scout", task: "inspect screenshot", bucket: "medium", modelRequirements: IMAGE_REQ },
		ctx: makeCtx(callerModel),
		agents: [makeAgent()],
		runtimeCtx: { depth: 0, trail: [], budget: { sessions: 0 } } as any,
		makeDetails: (results) => noOpDetails("single", results),
		onUpdate: () => {},
		signal: noSignal(),
		selectionCtx,
		toolCallId: "t-req-error",
		parentUiBridge: undefined,
		parentSessionId: undefined,
		allToolNames: undefined,
		_internal: {
			clock: new ImmediateClock(),
			runAttempt: () => {
				runAttemptCalls++;
				return Promise.resolve(syntheticResult({ exitCode: 0 }));
			},
		},
	});

	assert.equal(runAttemptCalls, 0, "no child session may be dispatched when the requirement is unmet");
	assert.equal(response.isError, true);
	const result = response.details.results[0];
	assert.equal(result.exitCode, 1);
	assert.equal(result.modelRequirementsSatisfied, false);
	assert.deepEqual(result.requestedModelRequirements, IMAGE_REQ);
	assert.match(result.requirementDiagnostic!, /No enabled image-capable model/);
	assert.equal(result.attemptRecords?.length ?? 0, 0, "undispatched error records no attempts");
});

test("executeSingleTask: provider retry never escapes to a text-only model", async () => {
	const callerModel = model("parent", "parent-text-model", ["text"]);
	const models = [
		model("image-prov-a", "img-a", ["text", "image"]),
		model("image-prov-b", "img-b", ["text", "image"]),
		model("text-prov", "text-only", ["text"]),
	];
	const selectionCtx = makeSelectionCtx({
		modelRequirements: IMAGE_REQ,
		requirementQualifiedModelIds: new Set(["img-a", "img-b"]),
		callerModelInput: ["text"],
		bucketAssignments: { small: [], medium: ["img-a", "img-b", "text-only"], frontier: [] },
		registryModels: models,
		fallbackOnProviderFailure: true,
	});
	const attemptedModels: string[] = [];
	const response: any = await executeSingleTask({
		params: { agent: "scout", task: "inspect screenshot", bucket: "medium", modelRequirements: IMAGE_REQ },
		ctx: makeCtx(callerModel),
		agents: [makeAgent()],
		runtimeCtx: { depth: 0, trail: [], budget: { sessions: 0 } } as any,
		makeDetails: (results) => noOpDetails("single", results),
		onUpdate: () => {},
		signal: noSignal(),
		selectionCtx,
		toolCallId: "t-retry-image",
		parentUiBridge: undefined,
		parentSessionId: undefined,
		allToolNames: undefined,
		_internal: {
			clock: new ImmediateClock(),
			runAttempt: (resolved: any) => {
				attemptedModels.push(resolved.modelOverride);
				if (resolved.modelOverride === "img-a") {
					return Promise.resolve(syntheticResult({
						exitCode: 1,
						stopReason: "error",
						errorMessage: "timed out",
						stderr: "timed out",
						selectedModel: "img-a",
						model: "img-a",
						provider: "image-prov-a",
						retryable: true,
						replaySafety: "safe",
						failureClass: "timeout",
					}));
				}
				return Promise.resolve(syntheticResult({
					exitCode: 0,
					stopReason: "completed",
					selectedModel: resolved.modelOverride,
					model: resolved.modelOverride,
					provider: "image-prov-b",
				}));
			},
		},
	});

	assert.equal(response.isError, undefined);
	assert.deepEqual(attemptedModels, ["img-a", "img-b"], "every dispatched attempt is image-capable; text-only is never chosen");
	assert.ok(attemptedModels.every((m) => m.startsWith("img-")), "no text-only model was dispatched");
	const result = response.details.results[0];
	assert.equal(result.modelRequirementsSatisfied, true);
	assert.deepEqual(result.requestedModelRequirements, IMAGE_REQ);
	assert.equal(result.requirementDiagnostic, undefined);
	assert.equal(result.retryCount, 1);
});

test("executeSingleTask: exhausting every image model yields a requirement error, not a text-only escape", async () => {
	const callerModel = model("parent", "parent-text-model", ["text"]);
	const models = [
		model("image-prov-a", "img-a", ["text", "image"]),
		model("text-prov", "text-only", ["text"]),
	];
	const selectionCtx = makeSelectionCtx({
		modelRequirements: IMAGE_REQ,
		requirementQualifiedModelIds: new Set(["img-a"]),
		callerModelInput: ["text"],
		bucketAssignments: { small: [], medium: ["img-a", "text-only"], frontier: [] },
		registryModels: models,
		fallbackOnProviderFailure: true,
	});
	const attemptedModels: string[] = [];
	const response: any = await executeSingleTask({
		params: { agent: "scout", task: "inspect screenshot", bucket: "medium", modelRequirements: IMAGE_REQ },
		ctx: makeCtx(callerModel),
		agents: [makeAgent()],
		runtimeCtx: { depth: 0, trail: [], budget: { sessions: 0 } } as any,
		makeDetails: (results) => noOpDetails("single", results),
		onUpdate: () => {},
		signal: noSignal(),
		selectionCtx,
		toolCallId: "t-retry-exhaust",
		parentUiBridge: undefined,
		parentSessionId: undefined,
		allToolNames: undefined,
		_internal: {
			clock: new ImmediateClock(),
			runAttempt: (resolved: any) => {
				attemptedModels.push(resolved.modelOverride);
				return Promise.resolve(syntheticResult({
					exitCode: 1,
					stopReason: "error",
					errorMessage: "timed out",
					stderr: "timed out",
					selectedModel: resolved.modelOverride,
					model: resolved.modelOverride,
					provider: "image-prov-a",
					retryable: true,
					replaySafety: "safe",
					failureClass: "timeout",
				}));
			},
		},
	});

	assert.deepEqual(attemptedModels, ["img-a"], "only the image model is attempted; the text-only model is never chosen");
	assert.equal(response.isError, true);
	const result = response.details.results[0];
	assert.equal(result.modelRequirementsSatisfied, false);
	assert.match(result.requirementDiagnostic!, /No enabled image-capable model/);
	assert.equal(result.retryCount, undefined, "requirement error is terminal, not a model retry");
});

test("executeSingleTask: running, terminal, and retried snapshots retain requirement provenance", async () => {
	const callerModel = model("parent", "parent-text-model", ["text"]);
	const models = [
		model("image-prov-a", "img-a", ["text", "image"]),
		model("image-prov-b", "img-b", ["text", "image"]),
	];
	const selectionCtx = makeSelectionCtx({
		modelRequirements: IMAGE_REQ,
		requirementQualifiedModelIds: new Set(["img-a", "img-b"]),
		callerModelInput: ["text"],
		bucketAssignments: { small: [], medium: ["img-a", "img-b"], frontier: [] },
		registryModels: models,
		fallbackOnProviderFailure: true,
	});
	const snapshots: SingleResult[] = [];
	const response: any = await executeSingleTask({
		params: { agent: "scout", task: "inspect screenshot", bucket: "medium", modelRequirements: IMAGE_REQ },
		ctx: makeCtx(callerModel),
		agents: [makeAgent()],
		runtimeCtx: { depth: 0, trail: [], budget: { sessions: 0 } } as any,
		makeDetails: (results) => noOpDetails("single", results),
		onUpdate: (partial: any) => {
			const r = partial.details?.results?.[0];
			if (r) snapshots.push(r);
		},
		signal: noSignal(),
		selectionCtx,
		toolCallId: "t-provenance",
		parentUiBridge: undefined,
		parentSessionId: undefined,
		allToolNames: undefined,
		_internal: {
			clock: new ImmediateClock(),
			runAttempt: (resolved: any, _attemptId: string, onAttemptUpdate?: any) => {
				// Emit a running snapshot mid-attempt.
				if (onAttemptUpdate) {
					onAttemptUpdate({
						content: [{ type: "text", text: "running..." }],
						details: noOpDetails("single", [syntheticResult({
							exitCode: -1,
							selectedModel: resolved.modelOverride,
							model: resolved.modelOverride,
							provider: "image-prov-a",
							activityPhase: "streaming",
							streamingText: "running...",
						})]),
					});
				}
				if (resolved.modelOverride === "img-a") {
					return Promise.resolve(syntheticResult({
						exitCode: 1,
						stopReason: "error",
						selectedModel: "img-a",
						model: "img-a",
						provider: "image-prov-a",
						retryable: true,
						replaySafety: "safe",
						failureClass: "timeout",
					}));
				}
				return Promise.resolve(syntheticResult({
					exitCode: 0,
					stopReason: "completed",
					selectedModel: "img-b",
					model: "img-b",
					provider: "image-prov-b",
				}));
			},
		},
	});

	// Running snapshot carries provenance.
	const running = snapshots.find((s) => s.activityPhase === "streaming");
	assert.ok(running, "a running snapshot was emitted");
	assert.deepEqual(running!.requestedModelRequirements, IMAGE_REQ);
	assert.equal(running!.modelRequirementsSatisfied, true);

	// Terminal result carries provenance.
	assert.equal(response.isError, undefined);
	const terminal = response.details.results[0];
	assert.deepEqual(terminal.requestedModelRequirements, IMAGE_REQ);
	assert.equal(terminal.modelRequirementsSatisfied, true);
	assert.equal(terminal.retryCount, 1, "retried result retains provenance");

	// Compacted (terminalized) result retains provenance.
	const compacted = compactSingleResult(terminal);
	assert.deepEqual(compacted.requestedModelRequirements, IMAGE_REQ);
	assert.equal(compacted.modelRequirementsSatisfied, true);
});
