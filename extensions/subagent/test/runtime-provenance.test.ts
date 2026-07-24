import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	deriveEffectiveFamily,
	hashDelegatedPrompt,
	loadModelFamilies,
	withRuntimeProvenance,
} from "../src/runtime-provenance.js";
import type { SingleResult } from "../types.js";

function result(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "reviewer",
		agentSource: "user",
		task: "exact task\n",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	};
}

test("hashDelegatedPrompt hashes the exact unnormalized task input", () => {
	assert.equal(hashDelegatedPrompt("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	assert.notEqual(hashDelegatedPrompt("abc"), hashDelegatedPrompt("abc\n"));
	assert.notEqual(hashDelegatedPrompt(" abc"), hashDelegatedPrompt("abc"));
});

test("effective family uses provider-qualified catalog/runtime metadata with an explicit model-id fallback", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "subagent-family-"));
	const catalog = path.join(dir, "models.json");
	writeFileSync(catalog, JSON.stringify({
		providers: {
			"provider-a": { models: [{ id: "shared", family: "catalog-family" }] },
			"provider-b": { modelOverrides: { shared: { family: "other-family" } } },
		},
	}));
	const families = loadModelFamilies(catalog);

	assert.equal(deriveEffectiveFamily("provider-a", "shared", families), "catalog-family");
	assert.equal(deriveEffectiveFamily("provider-b", "shared", families), "other-family");
	assert.equal(deriveEffectiveFamily("runtime", "runtime-model", undefined, [
		{ provider: "runtime", id: "runtime-model", family: "runtime-family" },
	]), "runtime-family");
	assert.equal(deriveEffectiveFamily("unknown-provider", "unregistered-model", families), "unregistered-model");
	assert.equal(deriveEffectiveFamily("provider-a", undefined, families), "unknown");
});

test("withRuntimeProvenance exposes requested/effective bucket, parent call, prompt, and family", () => {
	const enriched = withRuntimeProvenance(result({
		provider: "provider-b",
		model: "model-b",
		bucket: "small",
		bucketDowngradeReason: "policy downgrade",
	}), {
		promptHash: hashDelegatedPrompt("exact task\n"),
		requestedBucket: "medium",
		parentToolCallId: "parent-tool-call",
		registryModels: [{ provider: "provider-b", id: "model-b", family: "family-b" }],
	});

	assert.equal(enriched.promptHash, hashDelegatedPrompt("exact task\n"));
	assert.equal(enriched.requestedBucket, "medium");
	assert.equal(enriched.bucket, "small");
	assert.equal(enriched.bucketDowngraded, true);
	assert.equal(enriched.parentToolCallId, "parent-tool-call");
	assert.equal(enriched.family, "family-b");
});
