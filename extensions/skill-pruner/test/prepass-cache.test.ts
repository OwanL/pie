import test from "node:test";
import assert from "node:assert/strict";
import {
	buildPrepassFingerprint,
	cacheSuccessfulPrepass,
	cacheSuccessfulPrepassCrossSession,
	clearPrepassCacheForTesting,
	CROSS_SESSION_CACHE_MAX,
	getCachedPrepass,
	getCachedPrepassCrossSession,
	isPrepassContinuationPrompt,
	normalizePromptForExactCache,
	setPrepassCacheNowForTesting,
} from "../src/prepass-cache.js";
import type { LlmPruningInput } from "../llm-scorer.js";
import { __setPromptTemplate } from "../llm-scorer.js";
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
	__setPromptTemplate(null);
});

test("fingerprint changes when the resolved prepass prompt contract changes", () => {
	const before = buildPrepassFingerprint(input("implement it"), config);
	__setPromptTemplate('New output contract {"keep":[]} {{STRATEGY_INSTRUCTION}}');
	const after = buildPrepassFingerprint(input("implement it"), config);
	assert.notEqual(after, before);
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

// ---------------------------------------------------------------------------
// Cross-session exact-fingerprint LRU cache (max 64). Reuses a prior session's
// decision ONLY on an exact prompt + fingerprint match — never on continuation
// prompts (privacy: a "continue" in session B must not reuse session A's
// context-dependent decision).
// ---------------------------------------------------------------------------

test("cross-session cache: exact prompt + fingerprint hit across sessions", () => {
	const fingerprint = buildPrepassFingerprint(input("implement it"), config);
	cacheSuccessfulPrepassCrossSession("implement it", fingerprint, result);
	// A different session with the same prompt + fingerprint reuses the decision.
	const hit = getCachedPrepassCrossSession("implement it", fingerprint);
	assert.equal(hit?.cacheHit, true);
	assert.equal(hit?.latencyMs, 0);
	assert.deepEqual(hit?.prunedSkills, ["alpha"]);
	assert.equal(hit?.usage, undefined, "cache hits must not duplicate provider usage");
	assert.equal(hit?.rawSystemPrompt, "", "cache hits must not claim a provider prompt was sent");
	assert.equal(hit?.rawUserMessage, "");
});

test("cross-session cache: never matches continuation prompts (privacy)", () => {
	const fingerprint = buildPrepassFingerprint(input("implement it"), config);
	cacheSuccessfulPrepassCrossSession("implement it", fingerprint, result);
	// Continuation prompts are context-dependent: they must NOT reuse another
	// session's decision even when the (continuation) fingerprint matches.
	assert.equal(getCachedPrepassCrossSession("continue", fingerprint), null);
	assert.equal(getCachedPrepassCrossSession("go ahead", fingerprint), null);
	assert.equal(getCachedPrepassCrossSession("fix this", fingerprint), null);
});

test("cross-session cache: misses changed fingerprint and expired entry", () => {
	let time = 1_000;
	setPrepassCacheNowForTesting(() => time);
	const fingerprint = buildPrepassFingerprint(input("implement it"), config);
	cacheSuccessfulPrepassCrossSession("implement it", fingerprint, result);
	// A different fingerprint (changed context) → miss, even with the same prompt.
	const changed = buildPrepassFingerprint({ ...input("implement it"), contextFile: "OTHER.md" }, config);
	assert.equal(getCachedPrepassCrossSession("implement it", changed), null);
	// Expired entry → miss.
	time += 30 * 60 * 1000 + 1;
	assert.equal(getCachedPrepassCrossSession("implement it", fingerprint), null);
});

test("cross-session cache: parse failures and errors are not cached", () => {
	const fingerprint = buildPrepassFingerprint(input("implement it"), config);
	cacheSuccessfulPrepassCrossSession("implement it", fingerprint, { ...result, keptAllDueToParseFailure: true });
	assert.equal(getCachedPrepassCrossSession("implement it", fingerprint), null);
	cacheSuccessfulPrepassCrossSession("implement it", fingerprint, { ...result, error: "boom" });
	assert.equal(getCachedPrepassCrossSession("implement it", fingerprint), null);
});

test("cross-session cache: LRU evicts the least-recently-used entry at the bound", () => {
	// All entries share one fingerprint (the fingerprint ignores userPrompt);
	// distinct prompts give distinct cache keys.
	const fingerprint = buildPrepassFingerprint(input("task 0"), config);
	for (let i = 0; i < CROSS_SESSION_CACHE_MAX; i++) {
		cacheSuccessfulPrepassCrossSession(`task ${i}`, fingerprint, { ...result, prunedSkills: [`s${i}`] });
	}
	// Access every entry in insertion order, leaving task 0 as the LRU.
	for (let i = 0; i < CROSS_SESSION_CACHE_MAX; i++) {
		assert.equal(getCachedPrepassCrossSession(`task ${i}`, fingerprint)?.prunedSkills?.[0], `s${i}`);
	}
	// Inserting one past the bound evicts the LRU (task 0).
	cacheSuccessfulPrepassCrossSession(`task ${CROSS_SESSION_CACHE_MAX}`, fingerprint, { ...result, prunedSkills: ["s64"] });
	assert.equal(getCachedPrepassCrossSession("task 0", fingerprint), null, "LRU entry must be evicted");
	assert.equal(getCachedPrepassCrossSession(`task ${CROSS_SESSION_CACHE_MAX}`, fingerprint)?.prunedSkills?.[0], "s64");
	// A recently-used entry survives.
	assert.equal(getCachedPrepassCrossSession(`task ${CROSS_SESSION_CACHE_MAX - 1}`, fingerprint)?.prunedSkills?.[0], `s${CROSS_SESSION_CACHE_MAX - 1}`);
});

// ---------------------------------------------------------------------------
// Whitespace normalization for exact cache comparison.
// ---------------------------------------------------------------------------

test("normalizePromptForExactCache: trims and collapses internal whitespace", () => {
	assert.equal(normalizePromptForExactCache("implement  it"), "implement it");
	assert.equal(normalizePromptForExactCache("\n\t implement   it \n"), "implement it");
	assert.equal(normalizePromptForExactCache("implement it"), "implement it");
	// Case and punctuation are preserved (only the continuation matcher lowercases).
	assert.equal(normalizePromptForExactCache("Fix this!"), "Fix this!");
});

test("exact cache comparison normalizes whitespace (per-session and cross-session)", () => {
	const fingerprint = buildPrepassFingerprint(input("implement it"), config);
	const continuationFingerprint = buildPrepassFingerprint(input("implement it"), config, false);
	// Per-session: store with normal spacing, look up with extra spaces + trailing newline.
	cacheSuccessfulPrepass("s", "implement it", fingerprint, continuationFingerprint, result);
	assert.equal(getCachedPrepass("s", "implement  it\n", fingerprint, continuationFingerprint)?.cacheHit, true);
	// Cross-session: same normalization applies to the exact-match key.
	cacheSuccessfulPrepassCrossSession("implement it", fingerprint, result);
	assert.equal(getCachedPrepassCrossSession("  implement   it  ", fingerprint)?.cacheHit, true);
});

test("whitespace normalization does not change continuation matching", () => {
	const fingerprint = buildPrepassFingerprint(input("implement it"), config);
	const continuationFingerprint = buildPrepassFingerprint(input("implement it"), config, false);
	cacheSuccessfulPrepass("s", "implement it", fingerprint, continuationFingerprint, result);
	// A genuine continuation prompt still hits via the continuation path.
	assert.equal(getCachedPrepass("s", "continue", fingerprint, continuationFingerprint)?.cacheHit, true);
	// A genuinely different prompt still misses.
	assert.equal(getCachedPrepass("s", "summarize it", fingerprint, continuationFingerprint), null);
});
