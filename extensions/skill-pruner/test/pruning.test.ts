/**
 * Direct unit tests for the pure selection logic in
 * extensions/skill-pruner/src/pruning.ts.
 *
 * pruning.ts transitively imports state.ts, which runtime-imports
 * `formatSkillsForPrompt` from `@earendil-works/pi-coding-agent`. That package
 * is not resolvable from the repo root under tsx, so this file uses the same
 * createRequire + Module._resolveFilename mock bootstrap as the existing
 * integration.test.ts / copilot-headers.test.ts, then requires pruning.ts.
 *
 * These tests exercise the prune-list (exclusion) selection model: the LLM
 * names items to REMOVE; empty/null means keep everything.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PruningConfig } from "../types.js";
import type { Skill, ToolInfo } from "@earendil-works/pi-coding-agent";

installSdkResolverForTests();
const require = createRequire(import.meta.url);
const {
	shouldSkipPruning,
	resolveVisibleSkills,
	applySkillSelection,
	applyToolSelection,
	runPruningPrepass,
	resolvePrepassBudgets,
	prepassTimeoutMs,
	clonePruningConfig,
	resolveAuth,
	isTransportError,
	isTransportErrorMessage,
	PREPASS_MAX_TRANSPORT_RETRIES,
	LLM_TIMEOUT_MS_BY_THINKING_LEVEL,
	getRecentConversation,
	subagentContext,
	SKILLS_BLOCK_RE,
} = require("../src/pruning.ts") as typeof import("../src/pruning.js");

function installSdkResolverForTests(): void {
	// Isolate from host extension-toggle state (see integration.test.ts).
	delete process.env.PIE_EXTENSION_TOGGLES_JSON;

	const mockDir = mkdtempSync(path.join(tmpdir(), "skill-pruner-pruning-mock-"));
	const sdkPath = path.join(mockDir, "pi-coding-agent.cjs");
	writeFileSync(sdkPath, "exports.formatSkillsForPrompt = () => '';\n", "utf-8");
	const tuiPath = path.join(mockDir, "pi-tui.cjs");
	writeFileSync(tuiPath, "class Box{constructor(){}addChild(){}}class Text{constructor(t){this.text=t;}}module.exports={Box,Text};\n", "utf-8");

	const moduleWithResolver = Module as typeof Module & {
		_resolveFilename: (request: string, parent?: unknown, isMain?: boolean, options?: unknown) => string;
	};
	const originalResolveFilename = moduleWithResolver._resolveFilename;
	moduleWithResolver._resolveFilename = function resolveFilename(request, parent, isMain, options): string {
		if (request === "@earendil-works/pi-coding-agent") return sdkPath;
		if (request === "@earendil-works/pi-tui") return tuiPath;
		return originalResolveFilename.call(this, request, parent, isMain, options);
	};
}

// ---------------------------------------------------------------------------
// SKILLS_BLOCK_RE: robustness against host system-prompt layout drift
// ---------------------------------------------------------------------------

test("SKILLS_BLOCK_RE: matches the standard host layout", () => {
	const prompt = `Base prompt.\n\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\n\n<available_skills>\n  <skill>\n    <name>x</name>\n  </skill>\n</available_skills>\nTail.`;
	assert.ok(SKILLS_BLOCK_RE.test(prompt));
});

test("SKILLS_BLOCK_RE: tolerates a single leading newline (layout variation)", () => {
	const prompt = `Base prompt.\nThe following skills provide specialized instructions for specific tasks.\n\n<available_skills>\n</available_skills>`;
	assert.ok(SKILLS_BLOCK_RE.test(prompt), "should match even with one leading newline instead of two");
});

test("SKILLS_BLOCK_RE: tolerates extra blank lines / spaces before the block", () => {
	const prompt = `Base.\n\n\n   \nThe following skills provide specialized instructions for specific tasks.\n<available_skills>\n</available_skills>`;
	assert.ok(SKILLS_BLOCK_RE.test(prompt), "should match across extra blank lines and trailing whitespace");
});

test("SKILLS_BLOCK_RE: does not match when the skills block is absent", () => {
	assert.equal(SKILLS_BLOCK_RE.test("Base prompt without the skills block"), false);
});

test("SKILLS_BLOCK_RE: replace on the standard layout preserves surrounding text (unchanged behavior)", () => {
	const block = `\n\nThe following skills provide specialized instructions for specific tasks.\n\n<available_skills>\n  <skill>\n    <name>x</name>\n  </skill>\n</available_skills>`;
	const prompt = `Base.${block}\nTail.`;
	const replaced = prompt.replace(SKILLS_BLOCK_RE, "\n\nREPLACED");
	assert.equal(replaced, "Base.\n\nREPLACED\nTail.");
});

function skill(name: string, overrides: Partial<Skill> = {}): Skill {
	return {
		name,
		description: `desc for ${name}`,
		filePath: `/repo/skills/${name}/SKILL.md`,
		baseDir: `/repo/skills/${name}`,
		sourceInfo: {} as Skill["sourceInfo"],
		disableModelInvocation: false,
		...overrides,
	};
}

function skillsConfig(overrides: Partial<PruningConfig["skills"]> = {}): PruningConfig["skills"] {
	return { strategy: "discretion", ceiling: 8, pinned: [], alwaysKeep: [], ...overrides };
}

function config(overrides: Partial<PruningConfig> = {}): PruningConfig {
	const result: PruningConfig = {
		mode: "auto",
		model: "gpt-5-mini",
		provider: "github-copilot",
		thinkingLevel: "minimal",
		skills: skillsConfig(),
		...overrides,
	};
	return result;
}

function toolsConfig(overrides: Partial<NonNullable<PruningConfig["tools"]>> = {}): NonNullable<PruningConfig["tools"]> {
	return {
		strategy: "discretion",
		ceiling: 10,
		dependencies: { edit: ["read"], subagent: ["bash"] },
		alwaysKeep: [],
		...overrides,
	};
}

const allTools: ToolInfo[] = [
	{ name: "read", description: "Read file contents" },
	{ name: "edit", description: "Edit a file" },
	{ name: "bash", description: "Execute a bash command" },
	{ name: "subagent", description: "Delegate tasks" },
	{ name: "web_search", description: "Search the web" },
] as unknown as ToolInfo[];

const visibleSkills = [skill("alpha"), skill("beta"), skill("gamma")];

// ---------------------------------------------------------------------------
// shouldSkipPruning
// ---------------------------------------------------------------------------

test("shouldSkipPruning: off mode -> skip with reason 'off'", () => {
	const r = shouldSkipPruning({ prompt: "a sufficiently long prompt" } as any, config({ mode: "off" }));
	assert.deepEqual(r, { skip: true, reason: "off" });
});

test("shouldSkipPruning: short prompt -> skip with reason 'too-short'", () => {
	const r = shouldSkipPruning({ prompt: "hi" } as any, config({ mode: "auto" }));
	assert.deepEqual(r, { skip: true, reason: "too-short" });
});

test("shouldSkipPruning: prompt is trimmed before the length check", () => {
	// "   hi   " trims to "hi" (2 chars < MIN_PROMPT_LENGTH=8)
	const r = shouldSkipPruning({ prompt: "   hi   " } as any, config({ mode: "auto" }));
	assert.deepEqual(r, { skip: true, reason: "too-short" });
});

test("shouldSkipPruning: valid prompt in auto mode -> not skipped", () => {
	const r = shouldSkipPruning({ prompt: "refactor this code for clarity" } as any, config({ mode: "auto" }));
	assert.deepEqual(r, { skip: false });
});

test("shouldSkipPruning: exactly MIN_PROMPT_LENGTH (8) chars is not skipped", () => {
	const r = shouldSkipPruning({ prompt: "12345678" } as any, config({ mode: "auto" }));
	assert.deepEqual(r, { skip: false });
});

test("shouldSkipPruning: disabled-by-toggle overrides a valid prompt", () => {
	process.env.PIE_EXTENSION_TOGGLES_JSON = JSON.stringify({ "skill-pruner": false });
	try {
		const r = shouldSkipPruning({ prompt: "refactor this code for clarity" } as any, config({ mode: "auto" }));
		assert.deepEqual(r, { skip: true, reason: "disabled-by-toggle" });
	} finally {
		delete process.env.PIE_EXTENSION_TOGGLES_JSON;
	}
});

test("shouldSkipPruning: malformed toggle JSON is treated as not disabled", () => {
	process.env.PIE_EXTENSION_TOGGLES_JSON = "{not json";
	try {
		const r = shouldSkipPruning({ prompt: "refactor this code for clarity" } as any, config({ mode: "auto" }));
		assert.deepEqual(r, { skip: false });
	} finally {
		delete process.env.PIE_EXTENSION_TOGGLES_JSON;
	}
});

test("shouldSkipPruning: subagent context -> skip with reason 'subagent'", () => {
	// Inside a scoped subagent session the prepass is skipped: it is
	// main-agent-oriented and would add a 20–35s LLM call (plus a fail-open
	// failure mode) before the first streamed token, making subagents look hung.
	const r = subagentContext.run({ depth: 1 }, () =>
		shouldSkipPruning({ prompt: "refactor this code for clarity" } as any, config({ mode: "auto" })),
	);
	assert.deepEqual(r, { skip: true, reason: "subagent" });
});

test("shouldSkipPruning: nested subagent (depth > 1) still skips", () => {
	const r = subagentContext.run({ depth: 2 }, () =>
		shouldSkipPruning({ prompt: "refactor this code for clarity" } as any, config({ mode: "auto" })),
	);
	assert.deepEqual(r, { skip: true, reason: "subagent" });
});

test("shouldSkipPruning: subagent skip takes precedence over a too-short prompt", () => {
	// The subagent check runs before the too-short check, so even a tiny prompt
	// inside a subagent is skipped as 'subagent' (no prepass either way).
	const r = subagentContext.run({ depth: 1 }, () =>
		shouldSkipPruning({ prompt: "hi" } as any, config({ mode: "auto" })),
	);
	assert.deepEqual(r, { skip: true, reason: "subagent" });
});

// ---------------------------------------------------------------------------
// resolveVisibleSkills
// ---------------------------------------------------------------------------

test("resolveVisibleSkills: filters out disabled skills", () => {
	const skills = [skill("alpha"), skill("hidden", { disableModelInvocation: true }), skill("beta")];
	const { visibleSkills: vis, visibleSkillNames, effectivePinned } = resolveVisibleSkills(skills, config());
	assert.deepEqual(vis.map((s) => s.name), ["alpha", "beta"]);
	assert.deepEqual([...visibleSkillNames], ["alpha", "beta"]);
	assert.deepEqual(effectivePinned, []);
});

test("resolveVisibleSkills: effectivePinned unions pinned + alwaysKeep and drops missing/disabled", () => {
	const skills = [skill("alpha"), skill("beta"), skill("hidden", { disableModelInvocation: true })];
	const cfg = config({
		skills: skillsConfig({ pinned: ["alpha", "beta", "hidden", "ghost"], alwaysKeep: ["beta"] }),
	});
	const { effectivePinned } = resolveVisibleSkills(skills, cfg);
	// alpha + beta visible & kept; hidden is disabled (dropped); ghost not visible (dropped)
	assert.deepEqual(effectivePinned, ["alpha", "beta"]);
});

test("resolveVisibleSkills: disabled skill named in pinned is dropped (not forced)", () => {
	const skills = [skill("alpha"), skill("off", { disableModelInvocation: true })];
	const cfg = config({ skills: skillsConfig({ pinned: ["off"] }) });
	const { visibleSkills: vis, effectivePinned } = resolveVisibleSkills(skills, cfg);
	assert.deepEqual(vis.map((s) => s.name), ["alpha"]);
	assert.deepEqual(effectivePinned, []);
});

// ---------------------------------------------------------------------------
// applySkillSelection (prune-list / exclusion semantics)
// ---------------------------------------------------------------------------

test("applySkillSelection: null prune list -> keep all, no fail-open reason", () => {
	const r = applySkillSelection(visibleSkills, null, [], config());
	assert.deepEqual(r.includedSkillNames, ["alpha", "beta", "gamma"]);
	assert.deepEqual(r.excludedSkillNames, []);
	assert.equal(r.safeguardReason, undefined);
});

test("applySkillSelection: empty prune list -> keep all (nothing to prune)", () => {
	const r = applySkillSelection(visibleSkills, [], [], config());
	assert.deepEqual(r.includedSkillNames, ["alpha", "beta", "gamma"]);
	assert.deepEqual(r.excludedSkillNames, []);
	assert.equal(r.safeguardReason, undefined);
});

test("applySkillSelection: prunes only the named skills", () => {
	const r = applySkillSelection(visibleSkills, ["beta"], [], config());
	assert.deepEqual(r.includedSkillNames, ["alpha", "gamma"]);
	assert.deepEqual(r.excludedSkillNames, ["beta"]);
	assert.equal(r.safeguardReason, undefined);
});

test("applySkillSelection: ignores unknown names in the prune list", () => {
	const r = applySkillSelection(visibleSkills, ["beta", "nope"], [], config());
	assert.deepEqual(r.includedSkillNames, ["alpha", "gamma"]);
	assert.deepEqual(r.excludedSkillNames, ["beta"]);
});

test("applySkillSelection: pinned skills are protected from pruning", () => {
	const cfg = config({ skills: skillsConfig({ pinned: ["alpha"] }) });
	const r = applySkillSelection(visibleSkills, ["alpha", "beta"], ["alpha"], cfg);
	// alpha is pinned -> not pruned; beta pruned; gamma kept
	assert.ok(r.includedSkillNames.includes("alpha"));
	assert.ok(!r.excludedSkillNames.includes("alpha"));
	assert.deepEqual(r.excludedSkillNames, ["beta"]);
});

test("applySkillSelection: pruning every visible skill -> fail-open keeps all", () => {
	const r = applySkillSelection(visibleSkills, ["alpha", "beta", "gamma"], [], config());
	assert.deepEqual(r.includedSkillNames, ["alpha", "beta", "gamma"]);
	assert.deepEqual(r.excludedSkillNames, []);
	assert.ok(r.safeguardReason, "fail-open reason should be set");
	assert.match(r.safeguardReason!, /safeguard/i);
});

test("applySkillSelection: full skill-prune with toolsRemain=true -> prunes all (no safeguard)", () => {
	// When tools survive, zero skills leaves the agent fully functional (unlike
	// zero tools), so a legitimate full skill-prune is allowed through instead of
	// being overridden by the keep-all safeguard.
	const r = applySkillSelection(visibleSkills, ["alpha", "beta", "gamma"], [], config(), true);
	assert.deepEqual(r.includedSkillNames, []);
	assert.deepEqual(r.excludedSkillNames, ["alpha", "beta", "gamma"]);
	assert.equal(r.safeguardReason, undefined);
});

test("applySkillSelection: pinned survive even when LLM prunes everything else (no fail-open)", () => {
	const skills = [skill("a"), skill("b"), skill("c")];
	const r = applySkillSelection(skills, ["a", "b", "c"], ["a"], config());
	// a pinned -> kept; b,c pruned; something survives so no fail-open
	assert.deepEqual(r.includedSkillNames, ["a"]);
	assert.deepEqual(r.excludedSkillNames, ["b", "c"]);
	assert.equal(r.safeguardReason, undefined);
});

// ---------------------------------------------------------------------------
// applyToolSelection (prune-list / exclusion semantics)
// ---------------------------------------------------------------------------

test("applyToolSelection: null prune list -> keep all, no reason", () => {
	const r = applyToolSelection(allTools, null, config({ tools: toolsConfig() }));
	assert.deepEqual(r.includedToolNames, allTools.map((t) => t.name));
	assert.deepEqual(r.excludedToolNames, []);
	assert.equal(r.safeguardReason, undefined);
});

test("applyToolSelection: empty prune list -> keep all", () => {
	const r = applyToolSelection(allTools, [], config({ tools: toolsConfig() }));
	assert.deepEqual(r.includedToolNames, allTools.map((t) => t.name));
	assert.deepEqual(r.excludedToolNames, []);
	assert.equal(r.safeguardReason, undefined);
});

test("applyToolSelection: prunes only the named tools", () => {
	const r = applyToolSelection(allTools, ["web_search"], config({ tools: toolsConfig() }));
	assert.deepEqual(r.excludedToolNames, ["web_search"]);
	assert.ok(r.includedToolNames.includes("read"));
	assert.ok(!r.includedToolNames.includes("web_search"));
});

test("applyToolSelection: alwaysKeep tools protected from pruning", () => {
	const cfg = config({ tools: toolsConfig({ alwaysKeep: ["web_search"] }) });
	const r = applyToolSelection(allTools, ["web_search", "edit"], cfg);
	assert.ok(!r.excludedToolNames.includes("web_search"), "alwaysKeep web_search must survive");
	assert.ok(r.excludedToolNames.includes("edit"));
});

test("applyToolSelection: dependency of a kept tool is protected from pruning", () => {
	// edit depends on read; LLM tries to prune read but edit is kept -> read protected
	const cfg = config({ tools: toolsConfig({ dependencies: { edit: ["read"] } }) });
	const r = applyToolSelection(allTools, ["read"], cfg);
	assert.ok(!r.excludedToolNames.includes("read"), "read is a dep of kept edit -> protected");
	assert.deepEqual(r.excludedToolNames, []);
});

test("applyToolSelection: pruning a tool does not drag out its own dependencies", () => {
	// Pruning edit must not also remove read (read is kept independently).
	const cfg = config({ tools: toolsConfig({ dependencies: { edit: ["read"] } }) });
	const r = applyToolSelection(allTools, ["edit"], cfg);
	assert.deepEqual(r.excludedToolNames, ["edit"]);
	assert.ok(r.includedToolNames.includes("read"));
});

test("applyToolSelection: transitive dependency protection across a chain", () => {
	// a -> b -> c -> read; LLM prunes b and c, but a is kept, so the whole
	// dep chain (b, c, read) is protected and nothing gets pruned.
	const cfg = config({
		tools: toolsConfig({ dependencies: { a: ["b"], b: ["c"], c: ["read"] } }),
	});
	const toolsWithABC = [
		...allTools,
		{ name: "a", description: "da" },
		{ name: "b", description: "db" },
		{ name: "c", description: "dc" },
	] as unknown as ToolInfo[];
	const r = applyToolSelection(toolsWithABC, ["b", "c"], cfg);
	assert.ok(!r.excludedToolNames.includes("b"), "b is a transitive dep of kept a -> protected");
	assert.ok(!r.excludedToolNames.includes("c"), "c is a transitive dep of kept a -> protected");
	assert.deepEqual(r.excludedToolNames, []);
});

test("applyToolSelection: pruning every tool -> fail-open keeps all", () => {
	const r = applyToolSelection(allTools, allTools.map((t) => t.name), config({ tools: toolsConfig() }));
	assert.deepEqual(r.includedToolNames, allTools.map((t) => t.name));
	assert.deepEqual(r.excludedToolNames, []);
	assert.ok(r.safeguardReason);
});

test("applyToolSelection: no tools config -> keep all regardless of prune list", () => {
	const r = applyToolSelection(allTools, ["read"], config());
	assert.deepEqual(r.includedToolNames, allTools.map((t) => t.name));
	assert.deepEqual(r.excludedToolNames, []);
	assert.equal(r.safeguardReason, undefined);
});

test("applyToolSelection: empty allTools -> empty included/excluded", () => {
	const r = applyToolSelection([], ["read"], config({ tools: toolsConfig() }));
	assert.deepEqual(r.includedToolNames, []);
	assert.deepEqual(r.excludedToolNames, []);
});

test("applyToolSelection: request_tool is always protected (recovery tool can't be pruned)", () => {
	// Even with no alwaysKeep config and an explicit prune, the pruner's own
	// recovery tool must survive — pruning it would strand every other pruned
	// tool with no recovery path.
	const tools = [...allTools, { name: "request_tool", description: "recover pruned tools" }] as unknown as ToolInfo[];
	const r = applyToolSelection(tools, ["request_tool", "web_search"], config({ tools: toolsConfig() }));
	assert.ok(!r.excludedToolNames.includes("request_tool"), "request_tool must never be pruned");
	assert.ok(r.includedToolNames.includes("request_tool"));
	assert.ok(r.excludedToolNames.includes("web_search"), "other named tools are still pruned");
});

test("applyToolSelection: extraProtected (recovered) tools survive pruning", () => {
	// A tool recovered via request_tool is passed as extraProtected so the next
	// turn's prepass can't re-prune it (sticky recovery across turns).
	const r = applyToolSelection(allTools, ["web_search", "edit"], config({ tools: toolsConfig() }), new Set(["web_search"]));
	assert.ok(!r.excludedToolNames.includes("web_search"), "recovered web_search must survive");
	assert.ok(r.excludedToolNames.includes("edit"), "non-recovered named tool is still pruned");
});

// ---------------------------------------------------------------------------
// runPruningPrepass: model/auth resolution errors fail open (no rejection)
// ---------------------------------------------------------------------------

test("runPruningPrepass: throwing model registry -> emptyResult with error, no rejection", async () => {
	const cfg = config({ tools: toolsConfig() });
	const dummyComplete = async () => ({ text: "" });
	const result = await runPruningPrepass(
		{ modelRegistry: { find: () => { throw new Error("registry boom"); } } },
		{ userPrompt: "refactor", skills: [], tools: [], config: cfg },
		cfg,
		dummyComplete as any,
	);
	assert.equal(result.prunedSkills, null);
	assert.equal(result.prunedTools, null);
	assert.ok(result.error);
	assert.match(result.error, /registry boom/);
});

// ---------------------------------------------------------------------------
// getRecentConversation: follow-up context from the session tree
// ---------------------------------------------------------------------------

interface FakeEntry {
	id: string;
	parentId: string | null;
	type: string;
	message?: { role: string; content: unknown };
}

function fakeSessionManager(entries: FakeEntry[]) {
	const byId = new Map(entries.map((e) => [e.id, e]));
	return {
		getLeafEntry: () => entries[entries.length - 1],
		getEntry: (id: string) => byId.get(id),
	};
}

function msgEntry(id: string, parentId: string | null, role: string, content: unknown): FakeEntry {
	return { id, parentId, type: "message", message: { role, content } };
}

test("getRecentConversation: returns prior user/assistant turns in chronological order", () => {
	// Leaf is the last persisted entry; the current prompt is not persisted yet at
	// before_agent_start, so it is excluded — only prior turns appear.
	const entries = [
		msgEntry("m1", null, "user", [{ type: "text", text: "Make a pass over the pruner for robustness" }]),
		msgEntry("m2", "m1", "assistant", [{ type: "text", text: "Reviewing the extension" }, { type: "tool_use", name: "read" }, { type: "tool_use", name: "edit" }]),
		msgEntry("m3", "m2", "user", [{ type: "text", text: "Leave it uncommitted" }]),
		msgEntry("m4", "m3", "assistant", [{ type: "text", text: "Got it" }]),
	];
	const recent = getRecentConversation({ sessionManager: fakeSessionManager(entries) });
	assert.deepEqual(recent.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
	assert.equal(recent[0].text, "Make a pass over the pruner for robustness");
	assert.match(recent[1].text, /Reviewing the extension/);
	assert.match(recent[1].text, /\[tools used: read, edit\]/);
});

test("getRecentConversation: skips non-message entries in the chain", () => {
	const entries: FakeEntry[] = [
		msgEntry("m1", null, "user", [{ type: "text", text: "hello" }]),
		{ id: "c1", parentId: "m1", type: "thinking_level_change" },
		msgEntry("m2", "c1", "assistant", [{ type: "text", text: "hi there" }]),
	];
	const recent = getRecentConversation({ sessionManager: fakeSessionManager(entries) });
	assert.deepEqual(recent.map((m) => m.text), ["hello", "hi there"]);
});

test("getRecentConversation: stops at a compaction boundary", () => {
	const entries: FakeEntry[] = [
		msgEntry("m1", null, "user", [{ type: "text", text: "old pre-compaction" }]),
		{ id: "comp", parentId: "m1", type: "compaction" },
		msgEntry("m2", "comp", "user", [{ type: "text", text: "after compaction" }]),
		msgEntry("m3", "m2", "assistant", [{ type: "text", text: "reply" }]),
	];
	const recent = getRecentConversation({ sessionManager: fakeSessionManager(entries) });
	assert.deepEqual(recent.map((m) => m.text), ["after compaction", "reply"]);
});

test("getRecentConversation: caps at maxMessages, keeping the most recent", () => {
	const entries: FakeEntry[] = [];
	let parent: string | null = null;
	for (let i = 0; i < 10; i++) {
		const id = `m${i}`;
		entries.push(msgEntry(id, parent, i % 2 === 0 ? "user" : "assistant", [{ type: "text", text: `msg ${i}` }]));
		parent = id;
	}
	const recent = getRecentConversation({ sessionManager: fakeSessionManager(entries) }, 3);
	assert.equal(recent.length, 3);
	assert.deepEqual(recent.map((m) => m.text), ["msg 7", "msg 8", "msg 9"]);
});

test("getRecentConversation: handles string message content", () => {
	const entries: FakeEntry[] = [
		msgEntry("m1", null, "user", "a plain string prompt"),
		msgEntry("m2", "m1", "assistant", "a plain string reply"),
	];
	const recent = getRecentConversation({ sessionManager: fakeSessionManager(entries) });
	assert.deepEqual(recent.map((m) => m.text), ["a plain string prompt", "a plain string reply"]);
});

test("getRecentConversation: returns [] when the session lacks walk methods or is empty", () => {
	assert.deepEqual(getRecentConversation({ sessionManager: { getSessionId: () => "s" } }), []);
	assert.deepEqual(getRecentConversation({}), []);
	assert.deepEqual(getRecentConversation(undefined), []);
	assert.deepEqual(getRecentConversation({ sessionManager: fakeSessionManager([]) }), []);
});

// ---------------------------------------------------------------------------
// isTransportError / isTransportErrorMessage: classify transient upstream
// failures so the retry loop can distinguish "retry at same level" from
// "downgrade thinking level".
// ---------------------------------------------------------------------------

test("isTransportErrorMessage: detects 5xx / 429 status codes", () => {
	assert.ok(isTransportErrorMessage("OpenAI API error (500): 500 Internal Server Error"));
	assert.ok(isTransportErrorMessage("OpenAI API error (502): 502 Bad Gateway"));
	assert.ok(isTransportErrorMessage("OpenAI API error (503): 503 Service Unavailable"));
	assert.ok(isTransportErrorMessage("OpenAI API error (429): 429 Too Many Requests"));
});

test("isTransportErrorMessage: detects network/timeout keywords", () => {
	assert.ok(isTransportErrorMessage("fetch failed: ECONNRESET"));
	assert.ok(isTransportErrorMessage("request ETIMEDOUT"));
	assert.ok(isTransportErrorMessage("network error"));
	assert.ok(isTransportErrorMessage("Gateway Timeout"));
	assert.ok(isTransportErrorMessage("OpenAI Responses stream ended before a terminal response event"));
});

test("isTransportErrorMessage: rejects non-transport errors", () => {
	assert.ok(!isTransportErrorMessage("Model 'gpt-5-mini' not found in registry"));
	assert.ok(!isTransportErrorMessage("LLM pruning failed: returned no text response"));
	assert.ok(!isTransportErrorMessage("stopReason=error"));
	assert.ok(!isTransportErrorMessage("Invalid JSON in LLM response"));
	assert.ok(!isTransportErrorMessage(""));
});

test("isTransportError: classifies result by stopReason + errorMessage", () => {
	// The pi-ai signature: stopReason="error" + an HTTP-status-bearing errorMessage.
	assert.ok(isTransportError({ stopReason: "error", errorMessage: "OpenAI API error (500): 500 Internal Server Error", rawResponse: "" } as any));
	assert.ok(isTransportError({ stopReason: "error", errorMessage: "OpenAI API error (429): 429 Too Many Requests", rawResponse: "" } as any));
	// Non-error stopReason → not transport even if message looks like one.
	assert.ok(!isTransportError({ stopReason: "stop", errorMessage: "500 Internal Server Error", rawResponse: "" } as any));
	// Error stopReason but no status code → content error, not transport.
	assert.ok(!isTransportError({ stopReason: "error", errorMessage: "Invalid JSON", rawResponse: "" } as any));
	// Local AbortSignal.timeout still downgrades thinking instead of retrying at the same budget.
	assert.ok(!isTransportError({ stopReason: "aborted", errorMessage: "OpenAI Responses stream ended before a terminal response event", rawResponse: "" } as any));
	// No result at all.
	assert.ok(!isTransportError(undefined));
});

test("isTransportError: classifies thrown errors by message", () => {
	const transportErr = new Error("OpenAI API error (500): 500 Internal Server Error");
	assert.ok(isTransportError(undefined, transportErr));
	const contentErr = new Error("Model not found");
	assert.ok(!isTransportError(undefined, contentErr));
});

test("PREPASS_MAX_TRANSPORT_RETRIES: is a positive number", () => {
	assert.equal(typeof PREPASS_MAX_TRANSPORT_RETRIES, "number");
	assert.ok(PREPASS_MAX_TRANSPORT_RETRIES > 0);
});

// ---------------------------------------------------------------------------
// runPruningPrepass: transport 500 retried at same thinking level before
// falling through. Verifies a transient gateway blip does not cause a
// terminal "no text response" — it retries, and recovers when the provider
// comes back.
// ---------------------------------------------------------------------------

/** A modelRegistry stub that resolves a model (so prepass reaches runLlmPruning). */
function modelRegistryStub() {
	return { find: () => ({ id: "gpt-5-mini", provider: "github-copilot" }) };
}

test("runPruningPrepass: 500 then recovery on retry -> returns parsed pruned skills", async () => {
	const cfg = config();
	let calls = 0;
	const completeFn = async () => {
		calls++;
		if (calls === 1) {
			// First call: transient transport 500.
			return { text: "", stopReason: "error", errorMessage: "OpenAI API error (500): 500 Internal Server Error" };
		}
		// Retry: valid prune-list JSON response.
		return { text: '{"pruneSkills":["alpha"],"pruneTools":[]}', stopReason: "stop" };
	};
	const result = await runPruningPrepass(
		{ modelRegistry: modelRegistryStub() },
		{ userPrompt: "do something", skills: visibleSkills, tools: allTools, config: cfg },
		cfg,
		completeFn as any,
	);
	assert.equal(calls, 2, "should have retried exactly once after the 500");
	assert.ok(result.prunedSkills, "should have parsed prune list after recovery");
	assert.deepEqual(result.prunedSkills, ["alpha"]);
	assert.equal(result.error, null);
});

test("runPruningPrepass: malformed JSON is retried once with a correction prompt", async () => {
	const cfg = config();
	let calls = 0;
	const completeFn = async (_model: unknown, context: Array<{ role: string; content: string }>) => {
		calls++;
		if (calls === 1) return { text: "I would keep alpha and read" };
		assert.deepEqual(context.slice(-2).map((message) => message.role), ["assistant", "user"]);
		assert.match(context.at(-1)?.content ?? "", /not valid JSON/i);
		return { text: '{"pruneSkills":["beta"],"pruneTools":[]}', stopReason: "stop" };
	};
	const result = await runPruningPrepass(
		{ modelRegistry: modelRegistryStub() },
		{ userPrompt: "do something", skills: visibleSkills, tools: allTools, config: cfg },
		cfg,
		completeFn as any,
	);
	assert.equal(calls, 2);
	assert.deepEqual(result.prunedSkills, ["beta"]);
	assert.equal(result.keptAllDueToParseFailure, undefined);
	assert.equal(result.error, null);
});

test("runPruningPrepass: persistent malformed JSON retries once then fails open", async () => {
	const cfg = config();
	let calls = 0;
	const completeFn = async () => {
		calls++;
		return { text: "still not json" };
	};
	const result = await runPruningPrepass(
		{ modelRegistry: modelRegistryStub() },
		{ userPrompt: "do something", skills: visibleSkills, tools: allTools, config: cfg },
		cfg,
		completeFn as any,
	);
	assert.equal(calls, 2, "parse recovery must be bounded to one retry");
	assert.deepEqual(result.prunedSkills, []);
	assert.deepEqual(result.prunedTools, []);
	assert.equal(result.keptAllDueToParseFailure, true);
	assert.equal(result.error, null);
});

test("runPruningPrepass: persistent 500 -> terminal error surfaced (not swallowed)", async () => {
	const cfg = config();
	let calls = 0;
	const completeFn = async () => {
		calls++;
		// Every call returns a transport 500.
		return { text: "", stopReason: "error", errorMessage: "OpenAI API error (500): 500 Internal Server Error" };
	};
	const result = await runPruningPrepass(
		{ modelRegistry: modelRegistryStub() },
		{ userPrompt: "do something", skills: visibleSkills, tools: allTools, config: cfg },
		cfg,
		completeFn as any,
	);
	// Should have retried: initial + transport retries (at same level).
	assert.ok(calls > 1, "should have retried at least once before failing: " + calls);
	// Fail-open keeps all skills: parsed empty prune list → [] (not null).
	assert.deepEqual(result.prunedSkills, []);
	assert.deepEqual(result.prunedTools, []);
	assert.ok(result.error, "error must be surfaced, not swallowed");
	assert.match(result.error, /500/);
});

test("runPruningPrepass: thrown transport error retried before failing open", async () => {
	const cfg = config();
	let calls = 0;
	const completeFn = async () => {
		calls++;
		if (calls === 1) throw new Error("OpenAI API error (503): 503 Service Unavailable");
		return { text: '{"pruneSkills":["beta"],"pruneTools":[]}', stopReason: "stop" };
	};
	const result = await runPruningPrepass(
		{ modelRegistry: modelRegistryStub() },
		{ userPrompt: "do something", skills: visibleSkills, tools: allTools, config: cfg },
		cfg,
		completeFn as any,
	);
	assert.equal(calls, 2, "thrown transport error should be retried");
	assert.deepEqual(result.prunedSkills, ["beta"]);
	assert.equal(result.error, null);
});

// ---------------------------------------------------------------------------
// prepass budgets: `pruning.prepass` overrides flow through to the LLM call.
// resolvePrepassBudgets merges config over built-in defaults; prepassTimeoutMs
// honors per-level overrides; runPruningPrepass disables pi-ai retries and
// forwards the configured output ceiling on every call.
// ---------------------------------------------------------------------------

test("resolvePrepassBudgets: returns built-in defaults when prepass absent", () => {
	const b = resolvePrepassBudgets(config());
	assert.equal(b.maxTransportRetries, PREPASS_MAX_TRANSPORT_RETRIES);
	assert.equal(b.maxOutputTokens, undefined);
	assert.equal(b.timeoutOverrides, undefined);
});

test("resolvePrepassBudgets: merges config overrides over defaults", () => {
	const cfg = config({ prepass: { timeoutMs: { minimal: 12000 }, maxOutputTokens: 333, maxTransportRetries: 5, transportBackoffBaseMs: 250 } });
	const b = resolvePrepassBudgets(cfg);
	assert.deepEqual(b.timeoutOverrides, { minimal: 12000 });
	assert.equal(b.maxTransportRetries, 5);
	assert.equal(b.transportBackoffBaseMs, 250);
	assert.equal(b.maxOutputTokens, 333);
});

test("prepassTimeoutMs: uses override when present, built-in otherwise", () => {
	assert.equal(prepassTimeoutMs("minimal", 0, { minimal: 12000 }), 12000);
	// 'low' not overridden → falls back to built-in LLM_TIMEOUT_MS_BY_THINKING_LEVEL.low
	assert.equal(prepassTimeoutMs("low", 0, { minimal: 12000 }), LLM_TIMEOUT_MS_BY_THINKING_LEVEL.low);
	// no overrides → built-in
	assert.equal(prepassTimeoutMs("high", 0), LLM_TIMEOUT_MS_BY_THINKING_LEVEL.high);
	// unknown level → falls back to minimal built-in
	assert.equal(prepassTimeoutMs("bogus", 0, { minimal: 12000 }), 12000);
});

test("prepassTimeoutMs: scales by attempt index", () => {
	assert.equal(prepassTimeoutMs("minimal", 0, { minimal: 10000 }), 10000);
	assert.equal(prepassTimeoutMs("minimal", 1, { minimal: 10000 }), 20000);
	assert.equal(prepassTimeoutMs("minimal", 2, { minimal: 10000 }), 30000);
});

test("runPruningPrepass: disables pi-ai retries and forwards configured maxOutputTokens", async () => {
	const cfg = config({ prepass: { maxTransportRetries: 7, maxOutputTokens: 333, temperature: 0.2 } });
	const seenOptions: Array<{ maxRetries?: number; maxTokens?: number; temperature?: number }> = [];
	const completeFn = async (_m: unknown, _c: unknown, options: { maxRetries?: number; maxTokens?: number; temperature?: number }) => {
		seenOptions.push(options);
		return { text: '{"pruneSkills":[],"pruneTools":[]}', stopReason: "stop" };
	};
	await runPruningPrepass(
		{ modelRegistry: modelRegistryStub() },
		{ userPrompt: "do something", skills: visibleSkills, tools: allTools, config: cfg },
		cfg,
		completeFn as any,
	);
	assert.ok(seenOptions.length >= 1, "prepass must have run at least once");
	for (const options of seenOptions) {
		assert.equal(options.maxRetries, 0);
		assert.equal(options.maxTokens, 333);
		assert.equal(options.temperature, 0.2);
	}
});

test("runPruningPrepass: omits maxTokens by default and disables pi-ai retries", async () => {
	const cfg = config();
	const seenOptions: Array<{ maxRetries?: number; maxTokens?: number }> = [];
	const completeFn = async (_m: unknown, _c: unknown, options: { maxRetries?: number; maxTokens?: number }) => {
		seenOptions.push(options);
		return { text: '{"pruneSkills":[],"pruneTools":[]}', stopReason: "stop" };
	};
	await runPruningPrepass(
		{ modelRegistry: modelRegistryStub() },
		{ userPrompt: "do something", skills: visibleSkills, tools: allTools, config: cfg },
		cfg,
		completeFn as any,
	);
	assert.ok(seenOptions.length >= 1);
	for (const options of seenOptions) {
		assert.equal(options.maxRetries, 0);
		assert.equal(options.maxTokens, undefined);
		assert.equal((options as { temperature?: number }).temperature, undefined);
	}
});

test("clonePruningConfig: deep-clones the prepass block (overrides are not shared by reference)", () => {
	const cfg = config({
		prepass: {
			timeoutMs: { minimal: 12000, low: 20000 },
			maxTransportRetries: 3,
			transportBackoffBaseMs: 750,
			oauthRaceBackoffMs: 0,
		},
	});
	const clone = clonePruningConfig(cfg);
	assert.deepEqual(clone.prepass, cfg.prepass);
	assert.notEqual(clone.prepass, cfg.prepass, "prepass object must be a new instance");
	assert.notEqual(clone.prepass!.timeoutMs, cfg.prepass!.timeoutMs, "timeoutMs map must be a new instance");
	// Mutating the clone must not leak back into the original.
	clone.prepass!.timeoutMs!.minimal = 99999;
	clone.prepass!.maxTransportRetries = 99;
	assert.equal(cfg.prepass!.timeoutMs!.minimal, 12000, "original timeoutMs untouched");
	assert.equal(cfg.prepass!.maxTransportRetries, 3, "original maxTransportRetries untouched");
});

test("clonePruningConfig: leaves prepass undefined when absent", () => {
	const clone = clonePruningConfig(config());
	assert.equal(clone.prepass, undefined);
});

// ---------------------------------------------------------------------------
// resolveAuth: the configured oauthRaceBackoffMs gates the OAuth-token-race
// re-resolve. `0` skips it (one getApiKeyAndHeaders call); a positive value
// re-resolves once (two calls). Asserted via call count — no timing assertion,
// so the test is deterministic.
// ---------------------------------------------------------------------------

function authRegistryStub(stale: boolean) {
	let calls = 0;
	const registry = {
		getApiKeyAndHeaders: async () => {
			calls++;
			// `stale` simulates the OAuth race: ok=true but no usable apiKey, the
			// exact shape that triggers the copilot re-resolve branch.
			return { ok: true, apiKey: stale ? undefined : "bearer-token" };
		},
	};
	return { registry, calls: () => calls };
}

const copilotModel = { id: "gpt-5-mini", provider: "github-copilot" };

test("resolveAuth: oauthRaceBackoffMs=0 skips the re-resolve (single call, fails open)", async () => {
	const { registry, calls } = authRegistryStub(true);
	const auth = await resolveAuth({ modelRegistry: registry }, copilotModel, 0);
	assert.equal(calls(), 1, "must not re-resolve when backoff is 0");
	assert.equal(auth.authFailed, true, "stale key with no re-resolve fails open");
});

test("resolveAuth: positive oauthRaceBackoffMs re-resolves once (two calls)", async () => {
	const { registry, calls } = authRegistryStub(true);
	// 1ms backoff keeps the test fast while still exercising the sleep path.
	const auth = await resolveAuth({ modelRegistry: registry }, copilotModel, 1);
	assert.equal(calls(), 2, "must re-resolve exactly once on a stale copilot key");
	assert.equal(auth.authFailed, true, "still-stale key after re-resolve fails open");
});


