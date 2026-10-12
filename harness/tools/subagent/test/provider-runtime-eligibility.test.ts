import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveModel, type SelectionContext } from "../execute.js";
import { createSubagentModelRegistryView } from "../model-registry-eligibility.js";
import type { AgentConfig } from "../../../agent-instructions/agent-discovery/agents.js";

const agent: AgentConfig = {
	name: "worker", description: "test", systemPrompt: "", source: "user", filePath: "worker.md", bucket: "medium",
};

function selection(overrides: Partial<SelectionContext> = {}): SelectionContext {
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

test("resolveModel rejects an ineligible parent for always-parent, empty-bucket, and no-nested-bucket fallback", async () => {
	const isModelEligibleForSubagent = (provider: string, id: string) => !(provider === "parent-provider" && id === "parent-model");
	const alwaysParent = await resolveModel(agent, selection({
		alwaysParentModel: true, callerProvider: "parent-provider", isModelEligibleForSubagent,
	}), "parent-model");
	assert.equal(alwaysParent.modelOverride, "");
	assert.match(alwaysParent.requirementDiagnostic ?? "", /not eligible for subagents/);

	const emptyBucket = await resolveModel(agent, selection({
		callerProvider: "parent-provider", isModelEligibleForSubagent,
	}), "parent-model");
	assert.equal(emptyBucket.modelOverride, "");
	assert.match(emptyBucket.requirementDiagnostic ?? "", /not eligible for subagents/);

	const nestedFallback = await resolveModel(agent, selection({
		callerProvider: "parent-provider", isModelEligibleForSubagent,
		nestedAllowedBuckets: { small: false, medium: false, frontier: false },
	}), "parent-model", "medium", undefined, 1);
	assert.equal(nestedFallback.modelOverride, "");
	assert.match(nestedFallback.requirementDiagnostic ?? "", /not eligible for subagents/);
});

test("resolveModel eligibility filters bucket selection by provider-qualified model identity", async () => {
	const isModelEligibleForSubagent = (provider: string, id: string) => !(provider === "provider-a" && id === "shared");
	const resolved = await resolveModel(agent, selection({
		isModelEligibleForSubagent,
		modelConfig: [
			{ provider: "provider-a", id: "shared", thinking: ["high"] },
			{ provider: "provider-b", id: "shared", thinking: ["high"] },
		],
		bucketAssignments: { small: [], medium: [{ model: "provider-b/shared", thinkingLevel: "high" }], frontier: [] },
		allowedModelIds: new Set(["provider-b/shared"]),
	}), "parent-model", "medium");
	assert.equal(resolved.modelOverride, "provider-b/shared");
	assert.deepEqual(resolved.selection.pool, ["provider-b/shared"]);
});

test("bare duplicate stays on the ineligible caller provider, while an eligible provider-qualified model succeeds", async () => {
	const isModelEligibleForSubagent = (provider: string, id: string) => !(provider === "provider-a" && id === "shared");
	const common = {
		isModelEligibleForSubagent,
		callerProvider: "provider-a",
		modelConfig: [
			{ provider: "provider-a", id: "shared", thinking: ["high"] },
			{ provider: "provider-b", id: "shared", thinking: ["high"] },
		],
	};
	const bare = await resolveModel(agent, selection({
		...common,
		bucketAssignments: { small: [], medium: [{ model: "shared", thinkingLevel: "high" }], frontier: [] },
		allowedModelIds: new Set(["provider-b/shared", "caller-model"]),
	}), "caller-model", "medium");
	assert.equal(bare.modelOverride, "caller-model", "the bare id must not migrate to provider-b behind the caller's back");
	assert.equal(bare.selection.fallback, true);

	const qualified = await resolveModel(agent, selection({
		...common,
		bucketAssignments: { small: [], medium: [{ model: "provider-b/shared", thinkingLevel: "high" }], frontier: [] },
		allowedModelIds: new Set(["provider-b/shared"]),
	}), "caller-model", "medium");
	assert.equal(qualified.modelOverride, "provider-b/shared");
	assert.deepEqual(qualified.selection.pool, ["provider-b/shared"]);
});

test("legacy registries without an eligibility predicate retain their existing selection behavior", async () => {
	const resolved = await resolveModel(agent, selection({
		alwaysParentModel: true,
	}), "parent-model");
	assert.equal(resolved.modelOverride, "parent-model");
	assert.equal(resolved.requirementDiagnostic, undefined);
	assert.equal(resolved.modelRequirementsSatisfied, undefined);
});

test("child registry view filters exact provider-qualified models and request auth", async () => {
	const models = [
		{ provider: "provider-a", id: "shared" },
		{ provider: "provider-b", id: "shared" },
		{ provider: "provider-b", id: "other" },
	];
	let requested: { provider: string; id: string } | undefined;
	const registry = {
		getAvailable: () => models,
		getAll: () => models,
		find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		getApiKeyAndHeaders: async (model: typeof models[number]) => {
			requested = model;
			return { ok: true as const, apiKey: "secret" };
		},
		isModelEligibleForSubagent: (provider: string, id: string) => provider === "provider-b" && id === "shared",
	};
	const view = createSubagentModelRegistryView(registry);
	assert.deepEqual(view.getAvailable(), [models[1]]);
	assert.deepEqual(view.getAll(), [models[1]]);
	assert.equal(view.find("provider-a", "shared"), undefined);
	assert.equal(view.find("provider-b", "other"), undefined, "unknown ids are ineligible");
	assert.equal(view.find("provider-b", "shared"), models[1]);
	assert.deepEqual(await view.getApiKeyAndHeaders(models[1]), { ok: true, apiKey: "secret" });
	assert.equal(requested, models[1]);
	await assert.rejects(view.getApiKeyAndHeaders(models[0]), /not eligible for subagents/);
	assert.equal(requested, models[1], "blocked auth must not reach the native callback");
});

test("child registry guards an SDK-returned alternate provider/id and preserves native receivers", async () => {
	const allowed = { provider: "provider-b", id: "shared" };
	const changed = { provider: "provider-a", id: "shared" };
	class NativeRegistry {
		#calls = 0;
		isModelEligibleForSubagent(provider: string, id: string) { return provider === "provider-b" && id === "shared"; }
		getAvailable() { this.#calls++; return [allowed, changed]; }
		getAll() { this.#calls++; return [allowed, changed]; }
		find(_provider: string, _id: string) { this.#calls++; return changed; }
		async getApiKeyAndHeaders(_model: typeof allowed) { this.#calls++; return { ok: true }; }
		count() { return this.#calls; }
	}
	const native = new NativeRegistry();
	const view = createSubagentModelRegistryView(native);
	assert.deepEqual(view.getAvailable(), [allowed]);
	assert.deepEqual(view.getAll(), [allowed]);
	assert.equal(view.find("provider-b", "shared"), undefined, "SDK/native lookup cannot substitute an ineligible provider");
	await assert.rejects(view.getApiKeyAndHeaders(changed), /not eligible for subagents/);
	assert.equal(view.count(), 3, "all native methods ran with their owning receiver");
});

test("legacy registry without eligibility predicate preserves identity and behavior", () => {
	const legacy = { getAvailable: () => [], getAll: () => [], find: () => undefined };
	assert.equal(createSubagentModelRegistryView(legacy), legacy);
});

test("runner passes a child-only registry view to createSession", () => {
	const source = readFileSync(fileURLToPath(new URL("../runner.ts", import.meta.url)), "utf8");
	assert.match(source, /const childModelRegistry = createSubagentModelRegistryView\(modelRegistry\)/);
	assert.match(source, /modelRegistry: childModelRegistry/);
	assert.match(source, /authStorage: guardedRegistry\.authStorage/);
});

test("runner checks resolved-model eligibility before loading the SDK or creating a child session", () => {
	const source = readFileSync(fileURLToPath(new URL("../runner.ts", import.meta.url)), "utf8");
	const guard = source.indexOf("guardedRegistry.isModelEligibleForSubagent(resolvedModel.provider, resolvedModel.id)");
	assert.notEqual(guard, -1, "runner must enforce the provider-qualified eligibility predicate");
	assert.ok(guard < source.indexOf("const sdk = _internal?.sdk ?? (await loadSubagentSdk())"));
	assert.ok(guard < source.indexOf("createSessionPromise = sdk.createSession("));
});
