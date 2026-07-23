import test from "node:test";
import assert from "node:assert/strict";
import { resolveModel, readAlwaysParentModel, type SelectionContext } from "../src/execute.js";
import type { AgentConfig } from "../agents.js";
import { installProviderCapacityBridge } from "../../../shared/provider-capacity-bridge.js";

const SUBAGENT_ALWAYS_PARENT_MODEL_ENV = "PIE_SUBAGENT_ALWAYS_PARENT_MODEL";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "test",
		systemPrompt: "",
		source: "user",
		filePath: "worker.md",
		bucket: "medium",
		...overrides,
	};
}

function makeSelectionCtx(overrides: Partial<SelectionContext> = {}): SelectionContext {
	return {
		modelConfig: [],
		disabledProviders: new Set(),
		allowedModelIds: undefined,
		bucketAssignments: { small: ["haiku"], medium: ["sonnet"], frontier: ["opus"] },
		alwaysParentModel: false,
		nestedAllowedBuckets: { small: true, medium: true, frontier: true },
		...overrides,
	};
}

test("resolveModel uses bucket selection when alwaysParentModel is false", async () => {
	const agent = makeAgent();
	const ctx = makeSelectionCtx({ alwaysParentModel: false });
	const resolved = await resolveModel(agent, ctx, "parent-model", "medium");
	assert.equal(resolved.bucket, "medium");
	assert.equal(resolved.selection.fallback, false);
	assert.notEqual(resolved.modelOverride, "parent-model");
});

test("resolveModel short-circuits to parent model when alwaysParentModel is true", async () => {
	const agent = makeAgent();
	const ctx = makeSelectionCtx({ alwaysParentModel: true });
	const resolved = await resolveModel(agent, ctx, "parent-model", "medium");
	assert.equal(resolved.modelOverride, "parent-model");
	assert.equal(resolved.selection.fallback, true);
	assert.equal(resolved.selection.modelId, "parent-model");
	assert.deepEqual(resolved.selection.pool, []);
});

test("resolveModel defaults subagents to high reasoning", async () => {
	const resolved = await resolveModel(makeAgent(), makeSelectionCtx(), "parent-model", "medium");
	assert.equal(resolved.thinkingLevel, "high");
	assert.equal(resolved.selection.thinkingLevel, "high");
});

test("resolveModel caps per-call and agent reasoning above high", async () => {
	const perCall = await resolveModel(makeAgent(), makeSelectionCtx(), "parent-model", "medium", "xhigh");
	assert.equal(perCall.thinkingLevel, "high");
	assert.equal(perCall.selection.thinkingLevel, "high");

	const fromAgent = await resolveModel(makeAgent({ thinkingLevel: "xhigh" }), makeSelectionCtx(), "parent-model", "medium");
	assert.equal(fromAgent.thinkingLevel, "high");
	assert.equal(fromAgent.selection.thinkingLevel, "high");
});

test("resolveModel routes around saturated providers when enabled", async (t) => {
	const uninstall = installProviderCapacityBridge(() => ({
		busy: { immediatelyClaimable: false },
		open: { immediatelyClaimable: true },
	}));
	t.after(uninstall);
	const resolved = await resolveModel(
		makeAgent(),
		makeSelectionCtx({
			routeAroundSaturatedProviders: true,
			registryModels: [
				{ id: "busy-model", provider: "busy" },
				{ id: "open-model", provider: "open" },
			],
			bucketAssignments: { small: [], medium: ["busy-model", "open-model"], frontier: [] },
		}),
		"parent-model",
		"medium",
	);

	assert.equal(resolved.modelOverride, "open-model");
	assert.deepEqual(resolved.selection.pool, ["open-model"]);
});

test("resolveModel keeps the original bucket when every provider is saturated", async (t) => {
	const uninstall = installProviderCapacityBridge(() => ({
		busyA: { immediatelyClaimable: false },
		busyB: { immediatelyClaimable: false },
	}));
	t.after(uninstall);
	const resolved = await resolveModel(
		makeAgent(),
		makeSelectionCtx({
			routeAroundSaturatedProviders: true,
			registryModels: [
				{ id: "model-a", provider: "busyA" },
				{ id: "model-b", provider: "busyB" },
			],
			bucketAssignments: { small: [], medium: ["model-a", "model-b"], frontier: [] },
		}),
		"parent-model",
		"medium",
	);

	assert.deepEqual(resolved.selection.pool, ["model-a", "model-b"]);
	assert.equal(resolved.selection.fallback, false);
});

test("alwaysParentModel takes precedence over live capacity routing", async (t) => {
	const uninstall = installProviderCapacityBridge(() => ({
		parent: { immediatelyClaimable: false },
		open: { immediatelyClaimable: true },
	}));
	t.after(uninstall);
	const resolved = await resolveModel(
		makeAgent(),
		makeSelectionCtx({
			alwaysParentModel: true,
			routeAroundSaturatedProviders: true,
			registryModels: [{ id: "open-model", provider: "open" }],
			bucketAssignments: { small: [], medium: ["open-model"], frontier: [] },
		}),
		"parent-model",
		"medium",
	);

	assert.equal(resolved.modelOverride, "parent-model");
	assert.deepEqual(resolved.selection.pool, []);
});

test("resolveModel returns empty modelId when parent is excluded and alwaysParentModel is true", async () => {
	const agent = makeAgent();
	const ctx = makeSelectionCtx({ alwaysParentModel: true });
	const excluded = new Set(["parent-model"]);
	const resolved = await resolveModel(agent, ctx, "parent-model", "frontier", undefined, excluded);
	assert.equal(resolved.modelOverride, "");
	assert.equal(resolved.selection.fallback, true);
});

test("readAlwaysParentModel returns true for '1' and 'true', false otherwise", () => {
	const previous = process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV];
	try {
		delete process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV];
		assert.equal(readAlwaysParentModel(), false, "unset env var -> false");

		process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV] = "1";
		assert.equal(readAlwaysParentModel(), true, "'1' -> true");

		process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV] = "true";
		assert.equal(readAlwaysParentModel(), true, "'true' -> true");

		process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV] = "0";
		assert.equal(readAlwaysParentModel(), false, "'0' -> false");

		process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV] = "garbage";
		assert.equal(readAlwaysParentModel(), false, "unrecognized value -> false");
	} finally {
		if (previous === undefined) {
			delete process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV];
		} else {
			process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV] = previous;
		}
	}
});
