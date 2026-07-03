/**
 * Direct unit tests for the pure output builders in
 * extensions/skill-pruner/src/message-builders.ts.
 *
 * These helpers take already-resolved data and return immutable values with
 * no side effects, so they can be exercised directly without the SDK-mock
 * bootstrap that the orchestrator (pruning.ts) needs. `message-builders.ts`
 * only type-imports `@earendil-works/pi-coding-agent`, so a plain ESM import
 * resolves under tsx.
 *
 * The host editor exports PIE_EXTENSION_TOGGLES_JSON with skill-pruner
 * disabled when tests run inside the running editor; neutralize it so any
 * transitive state reads don't short-circuit. (These helpers don't read it,
 * but the deletion is cheap insurance and matches the repo convention.)
 */
import test from "node:test";
import assert from "node:assert/strict";

delete process.env.PIE_EXTENSION_TOGGLES_JSON;

import {
	buildHint,
	buildReplacement,
	buildDecision,
	estimateToolTokens,
	buildPruningPayload,
	buildFeedbackMessage,
} from "../src/message-builders.js";
import { estimateTokens } from "../logger.js";
import type { PruningConfig } from "../types.js";
import type { SkillPruningResult, ToolPruningResult } from "../src/pruning-types.js";

function config(overrides: Partial<PruningConfig> = {}): PruningConfig {
	return {
		mode: "auto",
		model: "gpt-5-mini",
		provider: "github-copilot",
		thinkingLevel: "minimal",
		skills: { strategy: "discretion", ceiling: 8, pinned: [], alwaysKeep: [] },
		...overrides,
	};
}

function skillResult(overrides: Partial<SkillPruningResult> = {}): SkillPruningResult {
	return { included: ["a"], excluded: ["b"], tokensSaved: 100, ...overrides };
}

function toolResult(overrides: Partial<ToolPruningResult> = {}): ToolPruningResult {
	return { included: ["read"], excluded: ["edit"], tokensSaved: 50, ...overrides };
}

// ---------------------------------------------------------------------------
// buildHint
// ---------------------------------------------------------------------------

test("buildHint: empty excluded list -> empty string", () => {
	assert.equal(buildHint([]), "");
});

test("buildHint: lists excluded skill names inside the HTML comment", () => {
	const hint = buildHint(["duckdb-query-optimization", "frontend-design"]);
	assert.equal(
		hint,
		"<!-- Pruned skills (not shown to save attention): duckdb-query-optimization, frontend-design. Use /skill:name to load one. -->",
	);
	assert.ok(hint.includes("duckdb-query-optimization"));
	assert.ok(hint.includes("frontend-design"));
});

test("buildHint: single excluded name is still wrapped", () => {
	assert.ok(buildHint(["solo"]).startsWith("<!-- Pruned skills"));
	assert.ok(buildHint(["solo"]).includes("solo"));
});

// ---------------------------------------------------------------------------
// buildReplacement
// ---------------------------------------------------------------------------

test("buildReplacement: wraps block with two leading newlines when no hint", () => {
	assert.equal(buildReplacement("SKILLS_BLOCK", ""), "\n\nSKILLS_BLOCK");
});

test("buildReplacement: strips a single leading blank line then re-prefixes", () => {
	// leading \n\n is stripped then re-added -> net unchanged prefix
	assert.equal(buildReplacement("\n\nSKILLS_BLOCK", ""), "\n\nSKILLS_BLOCK");
});

test("buildReplacement: appends hint on its own line when present", () => {
	const hint = buildHint(["x"]);
	assert.equal(buildReplacement("SKILLS_BLOCK", hint), `\n\nSKILLS_BLOCK\n${hint}`);
});

test("buildReplacement: only the first leading \\n\\n is stripped", () => {
	// regex is /^\n\n/ (single occurrence); remaining leading newlines stay
	assert.equal(buildReplacement("\n\n\nSKILLS", ""), "\n\n\nSKILLS");
});

// ---------------------------------------------------------------------------
// buildDecision
// ---------------------------------------------------------------------------

test("buildDecision: captures included/excluded/pinned/latency and token counts", () => {
	const newBlock = "The following skills provide specialized instructions.";
	const originalBlock = newBlock + "\nextra context line that makes it longer";
	const before = Date.now();
	const decision = buildDecision({
		sessionId: "sess-1",
		sessionPath: "/tmp/sess.jsonl",
		mode: "auto",
		query: "refactor this",
		contextFilePath: "AGENTS.md",
		llmModel: "gpt-5-mini",
		llmThinkingLevel: "minimal",
		llmResponse: '{"skills":["a"]}',
		llmLatencyMs: 432,
		included: ["a"],
		excluded: ["b", "c"],
		pinned: ["a"],
		newBlock,
		originalBlock,
	});
	const after = Date.now();

	assert.equal(decision.sessionId, "sess-1");
	assert.equal(decision.sessionPath, "/tmp/sess.jsonl");
	assert.equal(decision.mode, "auto");
	assert.equal(decision.query, "refactor this");
	assert.equal(decision.contextFile, "AGENTS.md");
	assert.equal(decision.llmModel, "gpt-5-mini");
	assert.equal(decision.llmThinkingLevel, "minimal");
	assert.equal(decision.llmResponse, '{"skills":["a"]}');
	assert.equal(decision.llmLatencyMs, 432);
	assert.deepEqual(decision.included, ["a"]);
	assert.deepEqual(decision.excluded, ["b", "c"]);
	assert.deepEqual(decision.pinned, ["a"]);
	// token counts come from the shared estimateTokens helper
	assert.equal(decision.skillBlockTokens, estimateTokens(newBlock));
	assert.equal(decision.originalBlockTokens, estimateTokens(originalBlock));
	assert.ok(
		decision.originalBlockTokens >= decision.skillBlockTokens,
		"longer original block should not have fewer tokens than the new block",
	);
	// timestamp is a valid ISO string within the call window
	const ts = Date.parse(decision.timestamp);
	assert.ok(Number.isFinite(ts), `timestamp is a valid ISO date: ${decision.timestamp}`);
	assert.ok(ts >= before && ts <= after, "timestamp should fall within the call window");
});

test("buildDecision: empty blocks yield zero tokens", () => {
	const decision = buildDecision({
		sessionId: "s",
		sessionPath: "p",
		mode: "shadow",
		query: "q",
		llmModel: "m",
		llmThinkingLevel: "minimal",
		llmResponse: "",
		llmLatencyMs: 0,
		included: [],
		excluded: [],
		pinned: [],
		newBlock: "",
		originalBlock: "",
	});
	assert.equal(decision.skillBlockTokens, 0);
	assert.equal(decision.originalBlockTokens, 0);
});

test("buildDecision: contextFile omitted when not provided", () => {
	const decision = buildDecision({
		sessionId: "s",
		sessionPath: "p",
		mode: "auto",
		query: "q",
		llmModel: "m",
		llmThinkingLevel: "minimal",
		llmResponse: "",
		llmLatencyMs: 0,
		included: [],
		excluded: [],
		pinned: [],
		newBlock: "x",
		originalBlock: "x",
	});
	assert.equal(decision.contextFile, undefined);
});

test("buildDecision: captures tool pruning data when provided", () => {
	const decision = buildDecision({
		sessionId: "s",
		sessionPath: "p",
		mode: "auto",
		query: "q",
		llmModel: "m",
		llmThinkingLevel: "minimal",
		llmResponse: "",
		llmLatencyMs: 0,
		included: ["a"],
		excluded: ["b"],
		pinned: [],
		newBlock: "x",
		originalBlock: "xx",
		toolIncluded: ["read"],
		toolExcluded: ["web_search"],
		toolBlockTokens: 40,
		originalToolBlockTokens: 60,
	});
	assert.deepEqual(decision.toolIncluded, ["read"]);
	assert.deepEqual(decision.toolExcluded, ["web_search"]);
	assert.equal(decision.toolBlockTokens, 40);
	assert.equal(decision.originalToolBlockTokens, 60);
});

test("buildDecision: tool fields stay undefined when tool pruning did not run", () => {
	const decision = buildDecision({
		sessionId: "s", sessionPath: "p", mode: "auto", query: "q",
		llmModel: "m", llmThinkingLevel: "minimal", llmResponse: "", llmLatencyMs: 0,
		included: ["a"], excluded: ["b"], pinned: [], newBlock: "x", originalBlock: "xx",
	});
	assert.equal(decision.toolIncluded, undefined);
	assert.equal(decision.toolExcluded, undefined);
	assert.equal(decision.toolBlockTokens, undefined);
	assert.equal(decision.originalToolBlockTokens, undefined);
});

// ---------------------------------------------------------------------------
// estimateToolTokens
// ---------------------------------------------------------------------------

const allTools = [
	{ name: "read", description: "Read file contents" },
	{ name: "edit", description: "Edit a file using exact text replacement" },
	{ name: "bash", description: "Execute a bash command in the working directory" },
	{ name: "web_search", description: "Search the web for information and return results" },
] as any[];

test("estimateToolTokens: zero when nothing is excluded", () => {
	assert.equal(estimateToolTokens(allTools, []), 0);
});

test("estimateToolTokens: zero when excluded names are not in allTools", () => {
	assert.equal(estimateToolTokens(allTools, ["nonexistent", "also-missing"]), 0);
});

test("estimateToolTokens: positive for a single excluded tool", () => {
	assert.ok(estimateToolTokens(allTools, ["read"]) > 0);
});

test("estimateToolTokens: additive across excluded tools", () => {
	const one = estimateToolTokens(allTools, ["read"]);
	const two = estimateToolTokens(allTools, ["edit"]);
	const both = estimateToolTokens(allTools, ["read", "edit"]);
	assert.equal(both, one + two);
});

test("estimateToolTokens: ignores tools not in the excluded set", () => {
	const onlyRead = estimateToolTokens(allTools, ["read"]);
	const allFour = estimateToolTokens(allTools, ["read", "edit", "bash", "web_search"]);
	assert.ok(allFour > onlyRead, "more excluded tools -> strictly more tokens");
});

test("estimateToolTokens: longer description yields strictly more tokens for same name", () => {
	const short = [{ name: "x", description: "a" }] as any[];
	const long = [{ name: "x", description: "a".repeat(200) }] as any[];
	assert.ok(estimateToolTokens(long, ["x"]) > estimateToolTokens(short, ["x"]));
});

// ---------------------------------------------------------------------------
// buildPruningPayload
// ---------------------------------------------------------------------------

test("buildPruningPayload: composes result envelope from skill/tool results", () => {
	const { result } = buildPruningPayload(
		skillResult({ included: ["a"], excluded: ["b"], tokensSaved: 100 }),
		toolResult({ included: ["read"], excluded: ["edit"], tokensSaved: 50 }),
		config({ mode: "auto" }),
		null,
		123,
		"minimal",
		'{"skills":["a"]}',
		"thinking...",
		"system prompt",
		"user message",
	);
	assert.deepEqual(result.includedSkills, ["a"]);
	assert.deepEqual(result.excludedSkills, ["b"]);
	assert.deepEqual(result.includedTools, ["read"]);
	assert.deepEqual(result.excludedTools, ["edit"]);
	assert.equal(result.mode, "auto");
	assert.equal(result.skillTokensSaved, 100);
	assert.equal(result.toolTokensSaved, 50);
	assert.equal(result.prepassModel, "gpt-5-mini");
	assert.equal(result.prepassThinkingLevel, "minimal");
	assert.equal(result.prepassLatencyMs, 123);
	assert.equal(result.prepassResponse, '{"skills":["a"]}');
	assert.equal(result.prepassThinking, "thinking...");
	assert.equal(result.prepassSystemPrompt, "system prompt");
	assert.equal(result.prepassUserMessage, "user message");
	assert.equal(result.prepassError, undefined);
	assert.equal(result.prepassSafeguardReason, undefined);
});

test("buildPruningPayload: null results default to empty arrays and zero saved", () => {
	const { result } = buildPruningPayload(null, null, config(), null, 0, "minimal", "", "", "", "", undefined, undefined);
	assert.deepEqual(result.includedSkills, []);
	assert.deepEqual(result.excludedSkills, []);
	assert.deepEqual(result.includedTools, []);
	assert.deepEqual(result.excludedTools, []);
	assert.equal(result.skillTokensSaved, 0);
	assert.equal(result.toolTokensSaved, 0);
	assert.equal(result.prepassError, undefined);
	assert.equal(result.prepassSafeguardReason, undefined);
});

test("buildPruningPayload: pruningError surfaced as prepassError", () => {
	const { result } = buildPruningPayload(null, null, config(), "model unavailable", 0, "minimal", "", "", "", "");
	assert.equal(result.prepassError, "model unavailable");
});

test("buildPruningPayload: fail-open reason joined with ' · ' when both skill and tool present", () => {
	const { result } = buildPruningPayload(null, null, config(), null, 0, "minimal", "", "", "", "", "skill reason", "tool reason");
	assert.equal(result.prepassSafeguardReason, "skill reason · tool reason");
});

test("buildPruningPayload: only skill fail-open reason surfaces when tool reason absent", () => {
	const { result } = buildPruningPayload(null, null, config(), null, 0, "minimal", "", "", "", "", "skill reason", undefined);
	assert.equal(result.prepassSafeguardReason, "skill reason");
});

test("buildPruningPayload: only tool fail-open reason surfaces when skill reason absent", () => {
	const { result } = buildPruningPayload(null, null, config(), null, 0, "minimal", "", "", "", "", undefined, "tool reason");
	assert.equal(result.prepassSafeguardReason, "tool reason");
});

test("buildPruningPayload: empty rawResponse becomes undefined prepassResponse", () => {
	const { result } = buildPruningPayload(null, null, config(), null, 0, "minimal", "", "t", "s", "u");
	assert.equal(result.prepassResponse, undefined);
	assert.equal(result.prepassThinking, "t");
	assert.equal(result.prepassSystemPrompt, "s");
	assert.equal(result.prepassUserMessage, "u");
});

// ---------------------------------------------------------------------------
// buildFeedbackMessage
// ---------------------------------------------------------------------------

test("buildFeedbackMessage: null when no skill/tool result and no prepass error", () => {
	assert.equal(buildFeedbackMessage(null, null, "auto"), null);
	assert.equal(buildFeedbackMessage(null, null, "auto", undefined), null);
});

test("buildFeedbackMessage: prepass error -> verbatim error content with diagnostics", () => {
	const msg = buildFeedbackMessage(null, null, "auto", {
		model: "gpt-5-mini",
		thinkingLevel: "minimal",
		response: "",
		thinking: "",
		systemPrompt: "",
		userMessage: "",
		latencyMs: 99,
		error: "model unavailable",
	});
	assert.ok(msg);
	assert.equal(msg!.customType, "pruning-result");
	assert.equal(msg!.display, true);
	assert.equal(msg!.content, "Pruning error (kept all skills): model unavailable");
	assert.equal(msg!.details.prepassModel, "gpt-5-mini");
	assert.equal(msg!.details.prepassThinkingLevel, "minimal");
	assert.equal(msg!.details.prepassLatencyMs, 99);
	assert.equal(msg!.details.prepassError, "model unavailable");
});

test("buildFeedbackMessage: includes mode/model/latency and fail-open reason when present", () => {
	const msg = buildFeedbackMessage(
		skillResult({ included: ["a"], excluded: ["b"], tokensSaved: 100 }),
		toolResult({ included: ["read"], excluded: ["edit"], tokensSaved: 50 }),
		"auto",
		{
			model: "gpt-5-mini",
			thinkingLevel: "minimal",
			response: "resp",
			thinking: "th",
			systemPrompt: "sp",
			userMessage: "um",
			latencyMs: 250,
			usage: { input: 8000, output: 200, cacheRead: 1000, cacheWrite: 50 },
			safeguardReason: "kept all skills as fail-open",
		},
	);
	assert.ok(msg);
	assert.equal(msg!.details.mode, "auto");
	assert.equal(msg!.details.prepassModel, "gpt-5-mini");
	assert.equal(msg!.details.prepassThinkingLevel, "minimal");
	assert.equal(msg!.details.prepassLatencyMs, 250);
	assert.equal(msg!.details.prepassInputTokens, 8000);
	assert.equal(msg!.details.prepassOutputTokens, 200);
	assert.equal(msg!.details.prepassCacheReadTokens, 1000);
	assert.equal(msg!.details.prepassCacheWriteTokens, 50);
	assert.equal(msg!.details.prepassSafeguardReason, "kept all skills as fail-open");
	assert.equal(msg!.details.skillTokensSaved, 100);
	assert.equal(msg!.details.toolTokensSaved, 50);
	assert.match(msg!.content, /Kept 1\/2 skills/);
	assert.match(msg!.content, /Kept 1\/2 tools/);
	assert.match(msg!.content, /Saved ~150 tokens/);
});

test("buildFeedbackMessage: omits fail-open reason when absent", () => {
	const msg = buildFeedbackMessage(
		skillResult({ included: ["a"], excluded: ["b"], tokensSaved: 10 }),
		null,
		"shadow",
		{
			model: "gpt-5-mini",
			thinkingLevel: "minimal",
			response: "r",
			thinking: "",
			systemPrompt: "",
			userMessage: "",
			latencyMs: 5,
		},
	);
	assert.ok(msg);
	assert.equal(msg!.details.prepassSafeguardReason, undefined);
	assert.equal(msg!.details.prepassModel, "gpt-5-mini");
	assert.equal(msg!.details.prepassLatencyMs, 5);
});

test("buildFeedbackMessage: nothing pruned -> neutral keep-all content, no token note, no alarming framing", () => {
	const msg = buildFeedbackMessage(
		skillResult({ included: ["a", "b"], excluded: [], tokensSaved: 0 }),
		toolResult({ included: ["read"], excluded: [], tokensSaved: 0 }),
		"auto",
	);
	assert.ok(msg);
	// Keep-all is the expected keep-biased outcome — frame it as kept counts,
	// not as a "(nothing removed)" / "Pruning:" warning.
	assert.match(msg!.content, /All 2 skills kept/);
	assert.match(msg!.content, /All 1 tools kept/);
	assert.doesNotMatch(msg!.content, /nothing removed/);
	assert.doesNotMatch(msg!.content, /^Pruning:/);
	assert.doesNotMatch(msg!.content, /Saved/);
	assert.doesNotMatch(msg!.content, /prepass/);
});

test("buildFeedbackMessage: nothing pruned -> surfaces prepass latency when provided", () => {
	const msg = buildFeedbackMessage(
		skillResult({ included: ["a", "b"], excluded: [], tokensSaved: 0 }),
		toolResult({ included: ["read"], excluded: [], tokensSaved: 0 }),
		"auto",
		{ model: "gpt-5-mini", thinkingLevel: "minimal", response: "", thinking: "", systemPrompt: "", userMessage: "", latencyMs: 8200 },
	);
	assert.ok(msg);
	assert.match(msg!.content, /All 2 skills kept/);
	assert.match(msg!.content, /· prepass 8\.2s/);
});

test("buildFeedbackMessage: pruned -> surfaces prepass latency alongside token savings", () => {
	const msg = buildFeedbackMessage(
		skillResult({ included: ["a"], excluded: ["b"], tokensSaved: 100 }),
		toolResult({ included: ["read"], excluded: ["edit"], tokensSaved: 50 }),
		"auto",
		{ model: "gpt-5-mini", thinkingLevel: "minimal", response: "", thinking: "", systemPrompt: "", userMessage: "", latencyMs: 450 },
	);
	assert.ok(msg);
	assert.match(msg!.content, /Kept 1\/2 skills/);
	assert.match(msg!.content, /Saved ~150 tokens/);
	assert.match(msg!.content, /· prepass 450ms/);
});

test("buildFeedbackMessage: prepass fields absent when prepass undefined", () => {
	const msg = buildFeedbackMessage(skillResult({ included: ["a"], excluded: [], tokensSaved: 0 }), null, "auto");
	assert.ok(msg);
	assert.equal(msg!.details.prepassModel, undefined);
	assert.equal(msg!.details.prepassLatencyMs, undefined);
	assert.equal(msg!.details.prepassSafeguardReason, undefined);
});
