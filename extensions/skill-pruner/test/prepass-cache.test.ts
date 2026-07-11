import test from "node:test";
import assert from "node:assert/strict";
import {
	buildPrepassFingerprint,
	cacheSuccessfulPrepass,
	clearPrepassCacheForTesting,
	getCachedPrepass,
	isPrepassContinuationPrompt,
	setPrepassCacheNowForTesting,
} from "../src/prepass-cache.js";
import type { LlmPruningInput } from "../llm-scorer.js";
import type { PrepassRunResult } from "../src/pruning-types.js";
import type { PruningConfig } from "../types.js";

const config: PruningConfig = {
	mode: "auto", model: "m", provider: "p", thinkingLevel: "minimal",
	skills: { strategy: "discretion", ceiling: 8, pinned: [], alwaysKeep: [] },
	tools: { strategy: "discretion", ceiling: 10, dependencies: {}, alwaysKeep: [] },
	autoSkipBelowTokens: null,
};
const input = (prompt: string): LlmPruningInput => ({
	userPrompt: prompt, contextFile: "AGENTS.md",
	skills: [{ name: "alpha", description: "Alpha" }],
	tools: [{ name: "read", description: "Read" }], config,
});
const result: PrepassRunResult = {
	prunedSkills: ["alpha"], prunedTools: [], error: null,
	rawResponse: '{"pruneSkills":["alpha"],"pruneTools":[]}', rawThinking: "",
	rawSystemPrompt: "system", rawUserMessage: "user", latencyMs: 50, thinkingLevel: "minimal",
	usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
};

test.afterEach(() => {
	clearPrepassCacheForTesting();
	setPrepassCacheNowForTesting(null);
});

test("cache hits exact and explicit continuation prompts with cache metadata", () => {
	const fingerprint = buildPrepassFingerprint(input("implement it"), config);
	const continuationFingerprint = buildPrepassFingerprint(input("implement it"), config, false);
	cacheSuccessfulPrepass("s", "implement it", fingerprint, continuationFingerprint, result);
	const exact = getCachedPrepass("s", "implement it", fingerprint, continuationFingerprint);
	assert.equal(exact?.cacheHit, true);
	assert.equal(exact?.latencyMs, 0);
	assert.deepEqual(exact?.prunedSkills, ["alpha"]);
	assert.equal(exact?.usage, undefined, "cache hits must not duplicate provider usage");
	assert.equal(exact?.rawSystemPrompt, "", "cache hits must not claim a provider prompt was sent");
	assert.equal(exact?.rawUserMessage, "");
	assert.equal(getCachedPrepass("s", "go ahead", fingerprint, continuationFingerprint)?.cacheHit, true);
	assert.equal(getCachedPrepass("s", "fix this!", fingerprint, continuationFingerprint)?.cacheHit, true);
});

test("cache misses changed arbitrary prompt, fingerprint, and expired entry", () => {
	let time = 1_000;
	setPrepassCacheNowForTesting(() => time);
	const fingerprint = buildPrepassFingerprint(input("implement it"), config);
	const continuationFingerprint = buildPrepassFingerprint(input("implement it"), config, false);
	cacheSuccessfulPrepass("s", "implement it", fingerprint, continuationFingerprint, result);
	assert.equal(getCachedPrepass("s", "summarize it", fingerprint, continuationFingerprint), null);
	const changed = buildPrepassFingerprint({ ...input("implement it"), contextFile: "OTHER.md" }, config);
	assert.equal(getCachedPrepass("s", "continue", changed, changed), null);
	time += 30 * 60 * 1000 + 1;
	assert.equal(getCachedPrepass("s", "continue", fingerprint, continuationFingerprint), null);
});

test("exact reuse includes recent conversation while explicit continuation reuse ignores it", () => {
	const original = { ...input("implement it"), recentConversation: [{ role: "user", text: "original task" }] };
	const changed = { ...input("implement it"), recentConversation: [{ role: "user", text: "different task" }] };
	const fingerprint = buildPrepassFingerprint(original, config);
	const continuationFingerprint = buildPrepassFingerprint(original, config, false);
	cacheSuccessfulPrepass("s", "implement it", fingerprint, continuationFingerprint, result);
	assert.equal(getCachedPrepass("s", "implement it", buildPrepassFingerprint(changed, config), continuationFingerprint), null);
	assert.equal(getCachedPrepass("s", "continue", buildPrepassFingerprint(changed, config), buildPrepassFingerprint(changed, config, false))?.cacheHit, true);
});

test("continuation matching is narrow and parse failures are not cached", () => {
	assert.equal(isPrepassContinuationPrompt("try again"), true);
	assert.equal(isPrepassContinuationPrompt("do it"), true);
	assert.equal(isPrepassContinuationPrompt("short question"), false);
	const fingerprint = buildPrepassFingerprint(input("implement it"), config);
	const continuationFingerprint = buildPrepassFingerprint(input("implement it"), config, false);
	cacheSuccessfulPrepass("s", "implement it", fingerprint, continuationFingerprint, { ...result, keptAllDueToParseFailure: true });
	assert.equal(getCachedPrepass("s", "implement it", fingerprint, continuationFingerprint), null);
});
