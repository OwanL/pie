import test from "node:test";
import assert from "node:assert/strict";
import { buildPruningSystemPrompt, buildPruningUserMessage, compactDescription, parseLlmResponse, runLlmPruning, __setPromptTemplate } from "../llm-scorer.js";
import type { PruningConfig } from "../types.js";

function makeConfig(overrides: Partial<PruningConfig> = {}): PruningConfig {
	return {
		mode: "auto",
		model: "gpt-5.4-mini",
		provider: "github-copilot",
		thinkingLevel: "minimal",
		skills: { strategy: "discretion", ceiling: 8, pinned: [], alwaysKeep: [] },
		tools: { strategy: "discretion", ceiling: 10, dependencies: {}, alwaysKeep: [] },
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// buildPruningSystemPrompt tests
// ---------------------------------------------------------------------------

test("buildPruningSystemPrompt includes discretion instruction for discretion strategy", () => {
	const config = makeConfig();
	const prompt = buildPruningSystemPrompt(config);
	assert.ok(prompt.includes("Use discretion"));
	assert.ok(prompt.includes("confident are irrelevant"));
	assert.ok(!prompt.includes("at most"));
});

test("buildPruningSystemPrompt includes topK instruction for topK strategy", () => {
	const config = makeConfig({
		skills: { strategy: "topK", ceiling: 5, pinned: [], alwaysKeep: [] },
		tools: { strategy: "topK", ceiling: 8, dependencies: {}, alwaysKeep: [] },
	});
	const prompt = buildPruningSystemPrompt(config);
	assert.ok(prompt.includes("at most 5 skills and 8 tools"));
	assert.ok(!prompt.includes("Use discretion"));
});

test("buildPruningSystemPrompt always includes core rules", () => {
	const prompt = buildPruningSystemPrompt(makeConfig());
	assert.ok(prompt.includes("relevance curator"));
	assert.ok(prompt.includes("JSON object"));
	assert.ok(prompt.includes("Do not wrap in markdown"));
	assert.ok(prompt.includes("REMOVE"), "prompt must frame the task as removal (prune-list)");
});

test("buildPruningSystemPrompt works with __setPromptTemplate test seam", () => {
	const customTemplate = "Custom template with {{SKILL_CEILING}} skills and {{TOOL_CEILING}} tools. {{STRATEGY_INSTRUCTION}}";
	__setPromptTemplate(customTemplate);
	try {
		const config = makeConfig({ skills: { strategy: "discretion", ceiling: 8, pinned: [], alwaysKeep: [] } });
		const prompt = buildPruningSystemPrompt(config);
		assert.ok(prompt.includes("Custom template with 8 skills and 10 tools"));
		assert.ok(prompt.includes("Use discretion"));
	} finally {
		__setPromptTemplate(null);
	}
});

// ---------------------------------------------------------------------------
// buildPruningUserMessage tests
// ---------------------------------------------------------------------------

test("buildPruningUserMessage includes user request and skill/tool lists framed as removal", () => {
	const msg = buildPruningUserMessage({
		userPrompt: "refactor this code",
		skills: [{ name: "code-simplification", description: "Simplifies code" }],
		tools: [{ name: "read", description: "Read files" }],
		config: makeConfig(),
	});
	assert.ok(msg.includes('User request: "refactor this code"'));
	assert.ok(msg.includes("Available skills (list any to REMOVE):"));
	assert.ok(msg.includes("- code-simplification: Simplifies code"));
	assert.ok(msg.includes("Available tools (list any to REMOVE):"));
	assert.ok(msg.includes("- read: Read files"));
});


test("buildPruningUserMessage includes recent conversation when provided", () => {
	const msg = buildPruningUserMessage({
		userPrompt: "new zealand, use the local conventions",
		recentConversation: [
			{ role: "user", text: "hello there, whats going on with the weather in wellington today" },
			{ role: "assistant", text: "Do you mean Wellington, New Zealand?" },
		],
		skills: [],
		tools: [],
		config: makeConfig(),
	});
	assert.ok(msg.includes("Recent conversation (use this to interpret follow-up requests):"));
	assert.ok(msg.includes("- user: hello there, whats going on with the weather in wellington today"));
	assert.ok(msg.includes("- assistant: Do you mean Wellington, New Zealand?"));
});

test("buildPruningUserMessage includes context file when provided", () => {
	const msg = buildPruningUserMessage({
		userPrompt: "help",
		contextFile: "AGENTS.md",
		skills: [],
		tools: [],
		config: makeConfig(),
	});
	assert.ok(msg.includes("Context file: AGENTS.md"));
});

test("buildPruningUserMessage omits context file when not provided", () => {
	const msg = buildPruningUserMessage({
		userPrompt: "help",
		skills: [],
		tools: [],
		config: makeConfig(),
	});
	assert.ok(!msg.includes("Context file"));
});

test("buildPruningUserMessage lists only the provided candidates and emits no protected-list framing", () => {
	// Protected (always-keep / pinned) skills and tools are excluded from the
	// candidate lists by the caller (register.ts) BEFORE reaching the builder —
	// the model is never told about them. The builder therefore lists only what
	// it is given and must not emit any "Protected …" framing; protection now
	// happens by omission, not by instruction.
	const msg = buildPruningUserMessage({
		userPrompt: "refactor",
		skills: [{ name: "alpha", description: "a" }],
		tools: [{ name: "read", description: "Read files" }],
		config: makeConfig(),
	});
	assert.ok(msg.includes("Available skills (list any to REMOVE):"));
	assert.ok(msg.includes("- alpha: a"));
	assert.ok(msg.includes("Available tools (list any to REMOVE):"));
	assert.ok(msg.includes("- read: Read files"));
	assert.ok(!msg.includes("Protected skills"), "builder must not emit protected-skill framing");
	assert.ok(!msg.includes("Protected tools"), "builder must not emit protected-tool framing");
	assert.ok(!/never removed/.test(msg), "builder must not reference protection in the prompt");
});

// ---------------------------------------------------------------------------
// compactDescription tests
// ---------------------------------------------------------------------------

test("compactDescription passes short descriptions through unchanged", () => {
	assert.equal(compactDescription("Read file contents"), "Read file contents");
	assert.equal(compactDescription(""), "");
});

test("compactDescription collapses internal whitespace/newlines to single spaces", () => {
	assert.equal(compactDescription("Read   a\n\nfile"), "Read a file");
});

test("compactDescription truncates a long multi-sentence tool description to its gist", () => {
	const long = "Delegate tasks to specialized subagents with isolated context. Modes: single (agent + task), parallel (tasks array), chain (sequential). Bucket hint for model selection: small, medium, or frontier. Available agents: reviewer, scout, worker.";
	const compact = compactDescription(long);
	assert.ok(compact.length < long.length, "should be shorter than the original");
	assert.ok(compact.length <= 180, "should respect the char cap");
	assert.ok(compact.startsWith("Delegate tasks to specialized subagents"), "keeps the leading summary");
	assert.ok(compact.endsWith(".") || compact.endsWith("\u2026"), "ends cleanly on a sentence or ellipsis");
});

test("compactDescription cuts on a word boundary with an ellipsis when no early sentence break exists", () => {
	const long = `${"word ".repeat(60)}end`;
	const compact = compactDescription(long);
	assert.ok(compact.length <= 181, "cap plus the single ellipsis char");
	assert.ok(compact.endsWith("\u2026"));
	assert.ok(!compact.includes("  "), "no dangling double space before the ellipsis");
});

test("buildPruningUserMessage compacts long candidate descriptions inline", () => {
	const long = "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to the last 2000 lines or 50KB, whichever is hit first, and the full output is saved to a temp file when truncated.";
	const msg = buildPruningUserMessage({
		userPrompt: "run the tests",
		skills: [],
		tools: [{ name: "bash", description: long }],
		config: makeConfig(),
	});
	assert.ok(!msg.includes(long), "full verbose description must not reach the prompt");
	assert.ok(msg.includes("- bash: Execute a bash command in the current working directory."));
});

test("buildPruningUserMessage keeps a skill's 'Use when' trigger (no early sentence cut for skills)", () => {
	// The trigger sits in a LATER sentence than the summary. Tools would be cut
	// at the first sentence boundary, but skills must preserve the trigger since
	// it is the actual relevance signal.
	const skillDesc = "Disciplined diagnosis loop for hard bugs and performance regressions. Reproduce, minimise, hypothesise, instrument, fix, regression-test. Use when the user says debug this or reports a bug.";
	const msg = buildPruningUserMessage({
		userPrompt: "debug this",
		skills: [{ name: "diagnose", description: skillDesc }],
		tools: [],
		config: makeConfig(),
	});
	assert.ok(msg.includes("Use when the user says debug this"), "skill trigger must survive compaction");
});

// ---------------------------------------------------------------------------
// parseLlmResponse tests
// ---------------------------------------------------------------------------

test("parseLlmResponse parses valid JSON prune-list response", () => {
	const knownSkills = new Set(["alpha", "beta", "gamma"]);
	const knownTools = new Set(["read", "edit", "bash"]);
	const result = parseLlmResponse(
		'{"pruneSkills": ["alpha", "gamma"], "pruneTools": ["read"]}',
		knownSkills,
		knownTools,
	);
	assert.deepEqual(result.pruneSkills, ["alpha", "gamma"]);
	assert.deepEqual(result.pruneTools, ["read"]);
	assert.equal(result.keptAllDueToParseFailure, undefined);
});

test("parseLlmResponse filters unknown names", () => {
	const knownSkills = new Set(["alpha"]);
	const knownTools = new Set(["read"]);
	const result = parseLlmResponse(
		'{"pruneSkills": ["alpha", "unknown-skill"], "pruneTools": ["read", "unknown-tool"]}',
		knownSkills,
		knownTools,
	);
	assert.deepEqual(result.pruneSkills, ["alpha"]);
	assert.deepEqual(result.pruneTools, ["read"]);
});

test("parseLlmResponse handles JSON in markdown code block", () => {
	const knownSkills = new Set(["alpha"]);
	const knownTools = new Set(["read"]);
	const result = parseLlmResponse(
		'```json\n{"pruneSkills": ["alpha"], "pruneTools": ["read"]}\n```',
		knownSkills,
		knownTools,
	);
	assert.deepEqual(result.pruneSkills, ["alpha"]);
	assert.deepEqual(result.pruneTools, ["read"]);
});


test("parseLlmResponse extracts embedded JSON from surrounding prose", () => {
	const knownSkills = new Set(["alpha"]);
	const knownTools = new Set(["read"]);
	const result = parseLlmResponse(
		'Sure — remove this: {"pruneSkills": ["alpha"], "pruneTools": ["read"]}',
		knownSkills,
		knownTools,
	);
	assert.deepEqual(result.pruneSkills, ["alpha"]);
	assert.deepEqual(result.pruneTools, ["read"]);
	assert.equal(result.keptAllDueToParseFailure, undefined);
});

test("parseLlmResponse keeps everything when prose mentions names (no scrape)", () => {
	// Prose usually names items to KEEP, so we must not scrape known names out of
	// it and treat them as prunes. Keep all instead.
	const knownSkills = new Set(["code-simplification", "frontend-design"]);
	const knownTools = new Set(["read", "edit"]);
	const result = parseLlmResponse(
		"I think code-simplification and read would be useful",
		knownSkills,
		knownTools,
	);
	assert.deepEqual(result.pruneSkills, []);
	assert.deepEqual(result.pruneTools, []);
	// Prose is unreadable as a prune list → keep-all flagged as a parse failure.
	assert.equal(result.keptAllDueToParseFailure, true);
});

test("parseLlmResponse returns empty prune lists for completely invalid input", () => {
	const knownSkills = new Set(["alpha"]);
	const knownTools = new Set(["read"]);
	const result = parseLlmResponse("", knownSkills, knownTools);
	assert.deepEqual(result.pruneSkills, []);
	assert.deepEqual(result.pruneTools, []);
	// Empty input is a genuine parse failure (phases 1/2 cannot read it) → flag set.
	assert.equal(result.keptAllDueToParseFailure, true);
});

test("parseLlmResponse does NOT flag keptAllDueToParseFailure for a valid empty-JSON keep-all", () => {
	// A well-formed JSON response with empty prune lists is an INTENTIONAL
	// keep-all (the model deliberately kept everything) — NOT a parse failure.
	const knownSkills = new Set(["alpha", "beta"]);
	const knownTools = new Set(["read", "edit"]);
	const result = parseLlmResponse('{"pruneSkills":[],"pruneTools":[]}', knownSkills, knownTools);
	assert.deepEqual(result.pruneSkills, []);
	assert.deepEqual(result.pruneTools, []);
	assert.equal(result.keptAllDueToParseFailure, undefined);
});

test("parseLlmResponse handles missing pruneSkills/pruneTools keys gracefully", () => {
	const knownSkills = new Set(["alpha"]);
	const knownTools = new Set(["read"]);
	const result = parseLlmResponse('{"pruneSkills": ["alpha"]}', knownSkills, knownTools);
	assert.deepEqual(result.pruneSkills, ["alpha"]);
	assert.deepEqual(result.pruneTools, []);
});

test("parseLlmResponse extracts reasoning from JSON response", () => {
	const knownSkills = new Set(["alpha"]);
	const knownTools = new Set(["read"]);
	const result = parseLlmResponse(
		'{"reasoning":"Frontend bug needs no db skill","pruneSkills":["alpha"],"pruneTools":["read"]}',
		knownSkills,
		knownTools,
	);
	assert.deepEqual(result.pruneSkills, ["alpha"]);
	assert.deepEqual(result.pruneTools, ["read"]);
	assert.equal(result.reasoning, "Frontend bug needs no db skill");
});

test("parseLlmResponse omits reasoning when absent or empty", () => {
	const knownSkills = new Set(["alpha"]);
	const knownTools = new Set(["read"]);
	const withEmpty = parseLlmResponse(
		'{"reasoning":"","pruneSkills":["alpha"],"pruneTools":["read"]}',
		knownSkills,
		knownTools,
	);
	assert.equal(withEmpty.reasoning, undefined);
	const without = parseLlmResponse(
		'{"pruneSkills":["alpha"],"pruneTools":["read"]}',
		knownSkills,
		knownTools,
	);
	assert.equal(without.reasoning, undefined);
});

// ---------------------------------------------------------------------------
// runLlmPruning tests
// ---------------------------------------------------------------------------

test("runLlmPruning calls completeFn and returns parsed prune lists", async () => {
	const input = {
		userPrompt: "refactor code",
		skills: [
			{ name: "code-simplification", description: "Simplifies code" },
			{ name: "frontend-design", description: "Frontend UI" },
		],
		tools: [
			{ name: "read", description: "Read files" },
			{ name: "edit", description: "Edit files" },
		],
		config: makeConfig(),
	};

	const completeFn = async () => ({
		text: '{"pruneSkills": ["frontend-design"], "pruneTools": []}',
		thinking: 'Frontend skill is irrelevant to a pure refactor.',
	});

	const result = await runLlmPruning(input, undefined, {}, completeFn);
	assert.deepEqual(result.prunedSkills, ["frontend-design"]);
	assert.deepEqual(result.prunedTools, []);
	assert.ok(result.latencyMs >= 0);
	assert.ok(result.rawResponse.includes("frontend-design"));
	assert.equal(result.keptAllDueToParseFailure, undefined);
});

test("runLlmPruning propagates completion errors", async () => {
	const input = {
		userPrompt: "test",
		skills: [],
		tools: [],
		config: makeConfig(),
	};

	const completeFn = async () => { throw new Error("timeout"); };

	await assert.rejects(
		() => runLlmPruning(input, undefined, {}, completeFn),
		/timeout/,
	);
});

test("runLlmPruning keeps everything when the model returns non-JSON prose", async () => {
	const input = {
		userPrompt: "test",
		skills: [{ name: "alpha", description: "Alpha skill" }],
		tools: [{ name: "read", description: "Read files" }],
		config: makeConfig(),
	};

	const completeFn = async () => ({ text: "not json but alpha and read" });

	const result = await runLlmPruning(input, undefined, {}, completeFn);
	// Non-JSON prose is unreadable as a prune list → keep everything.
	assert.deepEqual(result.prunedSkills, []);
	assert.deepEqual(result.prunedTools, []);
	// Parse failure propagates through runLlmPruning so it stays observable downstream.
	assert.equal(result.keptAllDueToParseFailure, true);
});

test("runLlmPruning falls back to JSON reasoning when native thinking is absent", async () => {
	const input = {
		userPrompt: "refactor code",
		skills: [{ name: "code-simplification", description: "Simplifies code" }],
		tools: [{ name: "read", description: "Read files" }],
		config: makeConfig(),
	};

	const completeFn = async () => ({
		text: '{"reasoning":"No extra tooling needed","pruneSkills":["code-simplification"],"pruneTools":["read"]}',
	});

	const result = await runLlmPruning(input, undefined, {}, completeFn);
	assert.deepEqual(result.prunedSkills, ["code-simplification"]);
	assert.equal(result.rawThinking, "No extra tooling needed");
});

test("runLlmPruning prefers native thinking over JSON reasoning", async () => {
	const input = {
		userPrompt: "refactor code",
		skills: [{ name: "code-simplification", description: "Simplifies code" }],
		tools: [{ name: "read", description: "Read files" }],
		config: makeConfig(),
	};

	const completeFn = async () => ({
		text: '{"reasoning":"JSON reasoning","pruneSkills":["code-simplification"],"pruneTools":["read"]}',
		thinking: "Native reasoning",
	});

	const result = await runLlmPruning(input, undefined, {}, completeFn);
	assert.equal(result.rawThinking, "Native reasoning");
});
