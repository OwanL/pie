/**
 * Bug-finding tests for model-resolution.ts.
 *
 * Original tests: basic happy paths (use requested, fall back with diagnostic).
 * Added: empty registry, undefined caller, disabled providers, duplicate IDs,
 * exact-match optimization, priority edge cases, empty/whitespace requestedModel.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@mariozechner/pi-ai";
import { resolveExecutionModel } from "../model-resolution.js";

function model(provider: string, id: string): Model<any> {
	return { provider, id } as Model<any>;
}

function registry(models: Model<any>[]) {
	return {
		getAvailable: () => models,
		getAll: () => models,
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
	};
}

// ============================================================
// HAPPY PATHS (preserved from original)
// ============================================================

test("resolveExecutionModel uses the requested model instead of inheriting the caller model", () => {
	const models = [
		model("github-copilot", "gpt-5.4"),
		model("github-copilot", "claude-opus-4.6"),
	];

	const result = resolveExecutionModel(
		registry(models),
		model("github-copilot", "gpt-5.4"),
		"claude-opus-4.6",
	);

	assert.equal(result.resolvedModel?.id, "claude-opus-4.6");
	assert.equal(result.actualModelId, "claude-opus-4.6");
	assert.equal(result.diagnostic, undefined);
});

test("resolveExecutionModel also resolves agent-frontmatter model requests", () => {
	const models = [
		model("github-copilot", "gpt-5.4"),
		model("ollama", "qwen3.5:cloud"),
	];

	const result = resolveExecutionModel(
		registry(models),
		model("github-copilot", "gpt-5.4"),
		"qwen3.5:cloud",
	);

	assert.equal(result.resolvedModel?.id, "qwen3.5:cloud");
	assert.equal(result.actualModelId, "qwen3.5:cloud");
});

test("resolveExecutionModel falls back to the caller model with a diagnostic when the request is missing", () => {
	const models = [model("github-copilot", "gpt-5.4")];

	const result = resolveExecutionModel(
		registry(models),
		model("github-copilot", "gpt-5.4"),
		"claude-opus-4.6",
	);

	assert.equal(result.resolvedModel?.id, "gpt-5.4");
	assert.equal(result.actualModelId, "gpt-5.4");
	assert.match(result.diagnostic ?? "", /claude-opus-4\.6/);
	assert.match(result.diagnostic ?? "", /Falling back to caller\/default model/);
});

// ============================================================
// NO REQUESTED MODEL — inherits caller
// ============================================================

test("resolveExecutionModel: no requested model inherits caller model", () => {
	const models = [model("github-copilot", "gpt-5.4")];

	const result = resolveExecutionModel(
		registry(models),
		model("github-copilot", "gpt-5.4"),
		undefined,
	);

	assert.equal(result.resolvedModel?.id, "gpt-5.4");
	assert.equal(result.actualModelId, "gpt-5.4");
	assert.equal(result.diagnostic, undefined);
});

test("resolveExecutionModel: no requested model and no caller model returns undefined", () => {
	const result = resolveExecutionModel(
		registry([]),
		undefined,
		undefined,
	);

	assert.equal(result.resolvedModel, undefined);
	assert.equal(result.actualModelId, undefined);
	assert.equal(result.diagnostic, undefined);
});

test("resolveExecutionModel: empty string requestedModel treated as no request", () => {
	const models = [model("github-copilot", "gpt-5.4")];

	const result = resolveExecutionModel(
		registry(models),
		model("github-copilot", "gpt-5.4"),
		"",
	);

	// Empty string is falsy in JavaScript, so it passes `if (requestedModel)` check
	// and falls through to inherit caller model — this is correct behavior
	assert.equal(result.resolvedModel?.id, "gpt-5.4");
	assert.equal(result.diagnostic, undefined);
});

test("resolveExecutionModel: whitespace-only requestedModel treated as a real request (BUG?)", () => {
	const models = [model("github-copilot", "gpt-5.4")];

	const result = resolveExecutionModel(
		registry(models),
		model("github-copilot", "gpt-5.4"),
		"   ",
	);

	// "   " is truthy, so it enters the `if (requestedModel)` branch
	// It won't be found in the registry → falls back with diagnostic
	// This may be a bug: whitespace-only should probably be treated as "no request"
	assert.equal(result.resolvedModel?.id, "gpt-5.4");
	assert.match(result.diagnostic ?? "", /not found in registry/);
});

// ============================================================
// EMPTY REGISTRY
// ============================================================

test("resolveExecutionModel: empty registry with requested model falls back to caller", () => {
	const result = resolveExecutionModel(
		registry([]),
		model("github-copilot", "gpt-5.4"),
		"some-model",
	);

	assert.equal(result.resolvedModel?.id, "gpt-5.4");
	assert.match(result.diagnostic ?? "", /not found in registry/);
});

test("resolveExecutionModel: empty registry, no caller, with requested model returns undefined", () => {
	const result = resolveExecutionModel(
		registry([]),
		undefined,
		"some-model",
	);

	assert.equal(result.resolvedModel, undefined);
	assert.equal(result.actualModelId, undefined);
	assert.match(result.diagnostic ?? "", /not found in registry/);
});

// ============================================================
// REQUESTED MODEL MATCHES CALLER MODEL EXACTLY
// ============================================================

test("resolveExecutionModel: requested model same as caller returns caller's provider instance", () => {
	const models = [
		model("github-copilot", "gpt-5.4"),
		model("openai", "gpt-5.4"),
	];

	const result = resolveExecutionModel(
		registry(models),
		model("github-copilot", "gpt-5.4"),
		"gpt-5.4",
	);

	// Should prefer same provider
	assert.equal(result.resolvedModel?.provider, "github-copilot");
	assert.equal(result.resolvedModel?.id, "gpt-5.4");
	assert.equal(result.diagnostic, undefined);
});

test("resolveExecutionModel: requested model same as caller but caller provider disabled -> falls through", () => {
	const models = [
		model("github-copilot", "gpt-5.4"),
		model("openai", "gpt-5.4"),
	];

	const result = resolveExecutionModel(
		registry(models),
		model("github-copilot", "gpt-5.4"),
		"gpt-5.4",
		new Set(["github-copilot"]),
	);

	// github-copilot disabled, so it falls through to openai's gpt-5.4
	assert.equal(result.resolvedModel?.provider, "openai");
	assert.equal(result.resolvedModel?.id, "gpt-5.4");
});

// ============================================================
// DISABLED PROVIDERS
// ============================================================

test("resolveExecutionModel: disabled provider for caller model -> resolvedModel is undefined", () => {
	const models = [model("github-copilot", "gpt-5.4")];

	const result = resolveExecutionModel(
		registry(models),
		model("github-copilot", "gpt-5.4"),
		undefined,
		new Set(["github-copilot"]),
	);

	assert.equal(result.resolvedModel, undefined);
	assert.equal(result.actualModelId, undefined);
});

test("resolveExecutionModel: requested model only on disabled provider gives diagnostic", () => {
	const models = [
		model("ollama", "local-model"),
	];

	const result = resolveExecutionModel(
		registry(models),
		model("github-copilot", "gpt-5.4"),
		"local-model",
		new Set(["ollama"]),
	);

	assert.equal(result.resolvedModel?.id, "gpt-5.4");
	assert.match(result.diagnostic ?? "", /only available from disabled provider/);
	assert.match(result.diagnostic ?? "", /ollama/);
});

test("resolveExecutionModel: multiple disabled matches listed in diagnostic", () => {
	const models = [
		model("disabled-a", "shared-model"),
		model("disabled-b", "shared-model"),
	];

	const result = resolveExecutionModel(
		registry(models),
		model("github-copilot", "gpt-5.4"),
		"shared-model",
		new Set(["disabled-a", "disabled-b"]),
	);

	assert.match(result.diagnostic ?? "", /disabled-a/);
	assert.match(result.diagnostic ?? "", /disabled-b/);
});

// ============================================================
// DUPLICATE MODEL IDs ACROSS PROVIDERS
// ============================================================

test("resolveExecutionModel: qualified duplicate resolves the exact configured provider", () => {
	const models = [
		model("github-copilot", "gpt-5.4"),
		model("openai-codex", "gpt-5.4"),
	];

	const result = resolveExecutionModel(
		registry(models),
		model("github-copilot", "caller-model"),
		"openai-codex/gpt-5.4",
	);

	assert.equal(result.resolvedModel?.provider, "openai-codex");
	assert.equal(result.actualModelId, "gpt-5.4");
	assert.equal(result.diagnostic, undefined);
});

test("resolveExecutionModel: qualified request never falls through to a duplicate provider", () => {
	const models = [
		model("github-copilot", "gpt-5.4"),
		model("openai-codex", "gpt-5.4"),
	];

	const result = resolveExecutionModel(
		registry(models),
		model("caller", "caller-model"),
		"github-copilot/gpt-5.4",
		new Set(["github-copilot"]),
	);

	assert.equal(result.resolvedModel?.provider, "caller");
	assert.notEqual(result.resolvedModel?.provider, "openai-codex");
	assert.match(result.diagnostic ?? "", /github-copilot/);
});

test("resolveExecutionModel: prefers caller's provider when model id exists there", () => {
	const models = [
		model("provider-a", "shared-model"),
		model("provider-b", "shared-model"),
	];

	const result = resolveExecutionModel(
		registry(models),
		model("provider-a", "some-model"),
		"shared-model",
	);

	assert.equal(result.resolvedModel?.provider, "provider-a");
	assert.equal(result.resolvedModel?.id, "shared-model");
});

test("resolveExecutionModel: skips a saturated caller provider for an immediately available duplicate", () => {
	const models = [
		model("provider-a", "shared-model"),
		model("provider-b", "shared-model"),
	];

	const result = resolveExecutionModel(
		registry(models),
		model("provider-a", "caller-model"),
		"shared-model",
		undefined,
		{
			"provider-a": { immediatelyClaimable: false },
			"provider-b": { immediatelyClaimable: true },
		},
	);

	assert.equal(result.resolvedModel?.provider, "provider-b");
});

test("resolveExecutionModel: preserves caller provider when every duplicate is saturated", () => {
	const models = [
		model("provider-a", "shared-model"),
		model("provider-b", "shared-model"),
	];

	const result = resolveExecutionModel(
		registry(models),
		model("provider-a", "caller-model"),
		"shared-model",
		undefined,
		{
			"provider-a": { immediatelyClaimable: false },
			"provider-b": { immediatelyClaimable: false },
		},
	);

	assert.equal(result.resolvedModel?.provider, "provider-a");
});

test("resolveExecutionModel: capacity-ranks duplicates when caller provider does not offer the id", () => {
	const models = [
		model("busy", "shared-model"),
		model("open", "shared-model"),
	];

	const result = resolveExecutionModel(
		registry(models),
		model("caller", "caller-model"),
		"shared-model",
		undefined,
		{
			busy: { immediatelyClaimable: false },
			open: { immediatelyClaimable: true },
		},
	);

	assert.equal(result.resolvedModel?.provider, "open");
});

test("resolveExecutionModel: treats an ungated duplicate as available", () => {
	const models = [
		model("busy", "shared-model"),
		model("ungated", "shared-model"),
	];

	const result = resolveExecutionModel(
		registry(models),
		model("caller", "caller-model"),
		"shared-model",
		undefined,
		{ busy: { immediatelyClaimable: false } },
	);

	assert.equal(result.resolvedModel?.provider, "ungated");
});

test("resolveExecutionModel: never selects a disabled available duplicate", () => {
	const models = [
		model("busy", "shared-model"),
		model("disabled-open", "shared-model"),
	];

	const result = resolveExecutionModel(
		registry(models),
		model("caller", "caller-model"),
		"shared-model",
		new Set(["disabled-open"]),
		{
			busy: { immediatelyClaimable: false },
			"disabled-open": { immediatelyClaimable: true },
		},
	);

	assert.equal(result.resolvedModel?.provider, "busy");
});

test("resolveExecutionModel: falls to any available provider when caller's provider doesn't have id", () => {
	const models = [
		model("provider-b", "unique-to-b"),
	];

	const result = resolveExecutionModel(
		registry(models),
		model("provider-a", "some-model"),
		"unique-to-b",
	);

	assert.equal(result.resolvedModel?.id, "unique-to-b");
	assert.equal(result.resolvedModel?.provider, "provider-b");
});

// ============================================================
// CALLER MODEL IS UNDEFINED
// ============================================================

test("resolveExecutionModel: undefined caller with valid requested model resolves to it", () => {
	const models = [model("github-copilot", "gpt-5.4")];

	const result = resolveExecutionModel(
		registry(models),
		undefined,
		"gpt-5.4",
	);

	assert.equal(result.resolvedModel?.id, "gpt-5.4");
	assert.equal(result.diagnostic, undefined);
});

test("resolveExecutionModel: undefined caller with invalid requested model returns undefined", () => {
	const models = [model("github-copilot", "gpt-5.4")];

	const result = resolveExecutionModel(
		registry(models),
		undefined,
		"nonexistent",
	);

	assert.equal(result.resolvedModel, undefined);
	assert.equal(result.actualModelId, undefined);
	assert.match(result.diagnostic ?? "", /not found in registry/);
});

// ============================================================
// getAvailable vs getAll distinction
// ============================================================

test("resolveExecutionModel: prefers available models over unavailable ones", () => {
	// Create a registry where `getAvailable` returns subset
	const allModels = [
		model("github-copilot", "available-model"),
		model("github-copilot", "unavailable-model"),
	];
	const r = {
		getAvailable: () => [allModels[0]], // only available-model is available
		getAll: () => allModels,
		find: (provider: string, id: string) => allModels.find((m) => m.provider === provider && m.id === id),
	};

	// Request "unavailable-model" — it's in getAll but not getAvailable
	const result = resolveExecutionModel(
		r,
		model("github-copilot", "available-model"),
		"unavailable-model",
	);

	// The code checks getAvailable first, then getAll
	// "unavailable-model" is NOT in getAvailable, but IS in getAll
	// So it should resolve to the unavailable-model from getAll
	assert.equal(result.resolvedModel?.id, "unavailable-model");
});

// ============================================================
// PRIORITY ORDERING
// ============================================================

test("resolveExecutionModel: caller same-provider lookup is disabled-provider-aware", () => {
	const models = [
		model("disabled-prov", "model-x"),
	];

	const result = resolveExecutionModel(
		registry(models),
		model("disabled-prov", "caller-model"),
		"model-x",
		new Set(["disabled-prov"]),
	);

	// Same-provider check: caller has disabled-prov, which is disabled → skip
	// getAvailable: model-x on disabled-prov, disabled → skip
	// getAll: model-x on disabled-prov, disabled → skip
	// Falls back (caller model is also on disabled-prov → resolvedModel is undefined)
	assert.equal(result.resolvedModel, undefined);
	assert.match(result.diagnostic ?? "", /only available from disabled provider/);
});

// ============================================================
// DIAGNOSTIC FORMATTING
// ============================================================

test("resolveExecutionModel: diagnostic truncates model list at 10 entries", () => {
	const models = Array.from({ length: 15 }, (_, i) =>
		model("github-copilot", `model-${i}`),
	);

	const result = resolveExecutionModel(
		registry(models),
		model("github-copilot", "model-0"),
		"nonexistent",
	);

	assert.match(result.diagnostic ?? "", /not found in registry/);
	// There are 15 models in the registry, but diagnostic should only list first 10
	const diagnostic = result.diagnostic ?? "";
	const idList = diagnostic.split("Available: ")[1]?.split(".")[0] ?? "";
	const ids = idList.split(", ").filter(Boolean);
	assert.ok(ids.length <= 10, `Should list at most 10 ids, got ${ids.length}: ${idList}`);
});

// ============================================================
// BOUNDARY: undefined disabledProviders
// ============================================================

test("resolveExecutionModel: undefined disabledProviders treated as no disabled providers", () => {
	const models = [model("github-copilot", "gpt-5.4")];

	const result = resolveExecutionModel(
		registry(models),
		model("github-copilot", "gpt-5.4"),
		"gpt-5.4",
		undefined, // not a Set
	);

	assert.equal(result.resolvedModel?.id, "gpt-5.4");
	assert.equal(result.diagnostic, undefined);
});

test("resolveExecutionModel: empty Set disabledProviders allows all", () => {
	const models = [model("github-copilot", "gpt-5.4")];

	const result = resolveExecutionModel(
		registry(models),
		model("github-copilot", "gpt-5.4"),
		"gpt-5.4",
		new Set(),
	);

	assert.equal(result.resolvedModel?.id, "gpt-5.4");
	assert.equal(result.diagnostic, undefined);
});
