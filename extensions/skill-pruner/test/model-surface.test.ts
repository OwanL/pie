import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, Skill, ToolInfo } from "@earendil-works/pi-coding-agent";
import { clearPruningTrackingForTesting, flushLog, setLogPathForTesting } from "../logger.js";
import type { PruningConfig } from "../types.js";

installSdkResolverForTests();
const require = createRequire(import.meta.url);
const { default: skillPruner, __setFormatter, __setToolSeams, __setCompleteFn, resetForTesting, setConfigForTesting } = require("../index.ts") as typeof import("../index.js");

function installSdkResolverForTests(): void {
	delete process.env.PIE_EXTENSION_TOGGLES_JSON;

	const mockDir = mkdtempSync(path.join(tmpdir(), "skill-pruner-modelsurface-mock-"));
	const sdkPath = path.join(mockDir, "pi-coding-agent.cjs");
	writeFileSync(sdkPath, "exports.formatSkillsForPrompt = () => { throw new Error('test must call __setFormatter'); };\n", "utf-8");
	const tuiPath = path.join(mockDir, "pi-tui.cjs");
	writeFileSync(tuiPath, [
		"class Box {",
		"  children = [];",
		"  constructor(px, py, bgFn) { this.paddingX = px; this.paddingY = py; this.bgFn = bgFn; }",
		"  addChild(c) { this.children.push(c); }",
		"  render(w) { return this.children.flatMap(c => c.render(w)); }",
		"}",
		"class Text {",
		"  constructor(text, px, py) { this.text = text; this.paddingX = px ?? 0; this.paddingY = py ?? 0; }",
		"  render(w) { return [this.text]; }",
		"}",
		"module.exports = { Box, Text };",
	].join("\n"), "utf-8");

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

function testFormatSkillsForPrompt(skills: Skill[]): string {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
	if (visibleSkills.length === 0) return "";
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use the absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function skill(name: string, description: string, overrides: Partial<Skill> = {}): Skill {
	return {
		name,
		description,
		filePath: `/repo/skills/${name}/SKILL.md`,
		baseDir: `/repo/skills/${name}`,
		sourceInfo: {} as Skill["sourceInfo"],
		disableModelInvocation: false,
		...overrides,
	};
}

function config(overrides: Partial<PruningConfig["skills"]> = {}, mode: PruningConfig["mode"] = "auto", toolsOverrides?: Partial<PruningConfig["tools"]>): PruningConfig {
	const result: PruningConfig = {
		mode,
		model: "gpt-5.4-mini",
		provider: "github-copilot",
		thinkingLevel: "minimal",
		skills: { strategy: "discretion", ceiling: 8, pinned: [], alwaysKeep: [], ...overrides },
	};
	if (toolsOverrides) {
		result.tools = {
			strategy: toolsOverrides.strategy ?? "discretion",
			ceiling: toolsOverrides.ceiling ?? 10,
			dependencies: toolsOverrides?.dependencies !== undefined
				? { ...toolsOverrides.dependencies }
				: { edit: ["read"], subagent: ["bash"] },
			alwaysKeep: toolsOverrides.alwaysKeep ?? [],
		};
	}
	return result;
}

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

type BeforeAgentStartReturn = { systemPrompt?: string; message?: any } | undefined;

type RegisterResult = {
	handlers: Map<string, Handler>;
	registeredTools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>;
	registeredRenderers: Map<string, (...args: any[]) => any>;
};

function register(configOverride: PruningConfig, logPath = path.join(mkdtempSync(path.join(tmpdir(), "skill-pruner-modelsurface-")), "pruning.jsonl")): RegisterResult {
	resetForTesting();
	clearPruningTrackingForTesting();
	setLogPathForTesting(logPath);
	setConfigForTesting(configOverride);
	__setFormatter(testFormatSkillsForPrompt);
	const handlers = new Map<string, Handler>();
	const registeredTools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }> = new Map();
	const registeredRenderers = new Map<string, (...args: any[]) => any>();
	const pi = {
		on(eventName: string, handler: Handler) { handlers.set(eventName, handler); },
		registerMessageRenderer(customType: string, renderer: any) { registeredRenderers.set(customType, renderer); },
		registerTool(toolDef: { name: string; execute?: (...args: unknown[]) => Promise<unknown> }) {
			if (toolDef.execute) registeredTools.set(toolDef.name, toolDef as { execute: (...args: unknown[]) => Promise<unknown> });
		},
		getAllTools: () => [] as ToolInfo[],
		getActiveTools: () => [] as string[],
		setActiveTools: (_names: string[]) => {},
	} as unknown as ExtensionAPI;
	skillPruner(pi);
	return { handlers, registeredTools, registeredRenderers };
}

function systemPrompt(skills: Skill[]): string {
	return `Base prompt.${testFormatSkillsForPrompt(skills)}\nCurrent date: 2026-05-16`;
}

async function runBeforeAgentStart(handlers: Map<string, Handler>, prompt: string, skills: Skill[], overrideSystemPrompt?: string): Promise<BeforeAgentStartReturn> {
	const handler = handlers.get("before_agent_start");
	assert.ok(handler, "before_agent_start handler registered");
	return await handler({
		type: "before_agent_start",
		prompt,
		systemPrompt: overrideSystemPrompt ?? systemPrompt(skills),
		systemPromptOptions: { cwd: "/repo", skills, contextFiles: [{ path: "AGENTS.md", content: "Project context" }] },
	}, { cwd: "/repo", sessionManager: { getSessionId: () => "session-1" } }) as BeforeAgentStartReturn;
}

/** Create a mock LLM completion function that returns a fixed prune-list response. */
function mockCompleteFn(response: { pruneSkills?: string[]; pruneTools?: string[] }) {
	return async () => ({ text: JSON.stringify({ pruneSkills: response.pruneSkills ?? [], pruneTools: response.pruneTools ?? [] }) });
}

const realisticSkills = [
	skill("code-simplification", "Simplifies code for clarity. Use when refactoring code for clarity, reducing complexity. Do not use when adding new features."),
	skill("duckdb-query-optimization", "Guides DuckDB query performance tuning. Use when queries against analytics databases are slow, writing new analytics queries. Do not use for general SQL questions."),
	skill("frontend-design", "Production-grade frontend interfaces. Use when building UI components, pages, or visual applications. Do not use for backend logic."),
];

const mockToolInfo = [
	{ name: "read", description: "Read file contents", parameters: { type: "object", properties: {} } },
	{ name: "edit", description: "Edit a file using exact text replacement", parameters: { type: "object", properties: {} } },
	{ name: "bash", description: "Execute a bash command", parameters: { type: "object", properties: {} } },
	{ name: "subagent", description: "Delegate tasks to specialized subagents", parameters: { type: "object", properties: {} } },
	{ name: "web_search", description: "Search the web for information", parameters: { type: "object", properties: {} } },
];

const allToolNames = mockToolInfo.map((t) => t.name);

// ---------------------------------------------------------------------------
// Model-surface fidelity tests (prune-list schema)
// These assert that the final pruning state matches the intent expressed by
// the pruning LLM (the prune list), and that the only deviations — pruning
// everything — are transparently reported via prepassSafeguardReason.
// ---------------------------------------------------------------------------

test("model prunes only unknown skill names → keeps all skills, no deviation reason", async () => {
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["nonexistent-skill"] }));
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "anything", realisticSkills);

		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.match(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
		assert.match(result.systemPrompt, /<name>frontend-design<\/name>/);

		// Unknown prunes are silently ignored (nothing real to remove); not a deviation.
		const feedback = result?.message;
		assert.equal(feedback?.details?.prepassSafeguardReason, undefined);
	} finally {
		__setCompleteFn(null);
	}
});

test("model prunes only unknown tool names → keeps all tools, no deviation reason", async () => {
	__setCompleteFn(mockCompleteFn({ pruneTools: ["nonexistent-tool"] }));
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 10 }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: () => {},
		});

		const result = await runBeforeAgentStart(handlers, "anything", realisticSkills);

		const details = result?.message?.details;
		assert.deepEqual(details.includedTools.sort(), allToolNames.slice().sort());
		assert.equal(details.excludedTools.length, 0);
		assert.equal(details.prepassSafeguardReason, undefined);
		assert.ok(result?.message, "handler should return the feedback message");
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("model prunes every skill → fail-open keeps all skills and reports reason", async () => {
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["code-simplification", "duckdb-query-optimization", "frontend-design"] }));
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "anything", realisticSkills);

		assert.ok(result?.systemPrompt);
		// Pruning 100% of skills is almost always a misunderstanding → fail-open.
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.match(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
		assert.match(result.systemPrompt, /<name>frontend-design<\/name>/);

		const details = result?.message?.details;
		assert.ok(details.prepassSafeguardReason, "prepassSafeguardReason should be populated when pruning was overridden");
		assert.ok(String(details.prepassSafeguardReason).includes("skill"), "reason should mention skills");
	} finally {
		__setCompleteFn(null);
	}
});

test("model prunes every tool → fail-open keeps all tools and reports reason", async () => {
	__setCompleteFn(mockCompleteFn({ pruneTools: [...allToolNames] }));
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 10 }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: () => {},
		});

		const result = await runBeforeAgentStart(handlers, "anything", realisticSkills);

		const details = result?.message?.details;
		assert.deepEqual(details.includedTools.sort(), allToolNames.slice().sort());
		assert.equal(details.excludedTools.length, 0);
		assert.ok(details.prepassSafeguardReason, "prepassSafeguardReason should be populated when pruning was overridden");
		assert.ok(String(details.prepassSafeguardReason).includes("tool"), "reason should mention tools");
		assert.ok(result?.message, "handler should return the feedback message");
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("model prunes a mix of known and unknown → known pruned, unknown ignored, no fail-open", async () => {
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["duckdb-query-optimization", "nonexistent-skill"] }));
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "refactor", realisticSkills);

		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);

		const feedback = result?.message;
		assert.equal(feedback?.details?.prepassSafeguardReason, undefined);
	} finally {
		__setCompleteFn(null);
	}
});

test("model prunes specific tools → setActiveTools keeps the rest exactly", async () => {
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(mockCompleteFn({ pruneTools: ["read", "subagent", "web_search"] }));
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 10, dependencies: {} }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});

		await runBeforeAgentStart(handlers, "edit and run", realisticSkills);

		assert.ok(setActiveToolsCalls.length > 0);
		const active = setActiveToolsCalls[0];
		assert.deepEqual(active.slice().sort(), ["bash", "edit"]);
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("dependency of a kept tool is protected from pruning", async () => {
	const setActiveToolsCalls: string[][] = [];
	// Model tries to prune read, but edit is kept and depends on read -> read protected.
	__setCompleteFn(mockCompleteFn({ pruneTools: ["read", "web_search"] }));
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 10, dependencies: { edit: ["read"] } }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});

		await runBeforeAgentStart(handlers, "edit files", realisticSkills);

		const active = setActiveToolsCalls[0];
		assert.ok(active.includes("read"), "read is a dep of kept edit -> protected from pruning");
		assert.ok(!active.includes("web_search"));
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("model prunes a subset of skills → the rest are kept, no fail-open", async () => {
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["duckdb-query-optimization", "frontend-design"] }));
	try {
		const { handlers } = register(config({ ceiling: 5 }));
		const result = await runBeforeAgentStart(handlers, "refactor", realisticSkills);

		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /<name>frontend-design<\/name>/);
		const feedback = result?.message;
		assert.equal(feedback?.details?.prepassSafeguardReason, undefined);
	} finally {
		__setCompleteFn(null);
	}
});

test("pinned skill protected even when the model prunes it", async () => {
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["code-simplification", "frontend-design"] }));
	try {
		const { handlers } = register(config({ pinned: ["code-simplification"] }));
		const result = await runBeforeAgentStart(handlers, "query optimization", realisticSkills);

		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.match(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /<name>frontend-design<\/name>/);
	} finally {
		__setCompleteFn(null);
	}
});

test("alwaysKeep tool protected even when the model prunes it", async () => {
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(mockCompleteFn({ pruneTools: ["web_search", "subagent"] }));
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 10, alwaysKeep: ["web_search"] }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});

		await runBeforeAgentStart(handlers, "edit files", realisticSkills);

		const active = setActiveToolsCalls[0];
		assert.ok(active.includes("web_search"), "alwaysKeep tool should survive pruning");
		assert.ok(!active.includes("subagent"));
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("model prunes tools but no tools config exists → tool intent silently discarded", async () => {
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["duckdb-query-optimization", "frontend-design"], pruneTools: ["web_search"] }));
	try {
		// config() without toolsOverrides produces a PruningConfig with NO tools field
		const { handlers } = register(config());
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});

		const result = await runBeforeAgentStart(handlers, "edit and run", realisticSkills);

		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		// Because activeConfig.tools is undefined, tool pruning is disabled.
		assert.equal(setActiveToolsCalls.length, 0, "setActiveTools should NOT be called when tools config is absent");
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("model prunes tools but no skills in session → tool pruning still applies", async () => {
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["nonexistent-skill"], pruneTools: ["read", "subagent", "web_search"] }));
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 10, dependencies: {} }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});

		await runBeforeAgentStart(handlers, "edit and run", []);

		assert.ok(setActiveToolsCalls.length > 0);
		const active = setActiveToolsCalls[0];
		assert.deepEqual(active.slice().sort(), ["bash", "edit"]);
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("shadow mode: model intent measured but not applied → feedback still reports model intent", async () => {
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["duckdb-query-optimization", "frontend-design"], pruneTools: ["bash", "subagent", "web_search"] }));
	try {
		const { handlers } = register(config({}, "shadow", { ceiling: 10 }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});

		const originalPrompt = systemPrompt(realisticSkills);
		const result = await runBeforeAgentStart(handlers, "refactor", realisticSkills, originalPrompt);

		assert.equal(result?.systemPrompt, originalPrompt);
		assert.equal(setActiveToolsCalls.length, 0);

		const feedback = result?.message;
		assert.ok(feedback);
		const details = feedback.details;
		assert.deepEqual(details.includedSkills, ["code-simplification"]);
		assert.deepEqual(details.excludedSkills, ["duckdb-query-optimization", "frontend-design"]);
		// read is a dep of kept edit -> protected; bash is a dep of pruned subagent -> pruned.
		assert.deepEqual(details.includedTools, ["read", "edit"]);
		assert.deepEqual(details.excludedTools, ["bash", "subagent", "web_search"]);
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("fail-open reason is absent when model intent is honored exactly", async () => {
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["duckdb-query-optimization", "frontend-design"] }));
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "refactor", realisticSkills);

		const feedback = result?.message;
		assert.ok(feedback);
		const details = feedback.details;
		assert.equal(details.prepassSafeguardReason, undefined, "no fail-open reason when model intent is honored");
		assert.ok(result?.message, "handler should return the feedback message");
	} finally {
		__setCompleteFn(null);
	}
});

test("non-JSON prose response → kept all, prepassSafeguardReason notes parse failure, decision persists flag", async () => {
	const logPath = path.join(mkdtempSync(path.join(tmpdir(), "skill-pruner-parsefail-")), "pruning.jsonl");
	__setCompleteFn(async () => ({ text: "I think code-simplification and read would both be useful here." }));
	try {
		const { handlers } = register(config(), logPath);
		const result = await runBeforeAgentStart(handlers, "refactor", realisticSkills);

		// Parse failure → keep-all (safe default); no names scraped out of prose.
		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.match(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
		assert.match(result.systemPrompt, /<name>frontend-design<\/name>/);

		// ... and it is observable via prepassSafeguardReason (distinguishable from an
		// intentional keep-all, which leaves prepassSafeguardReason undefined).
		const details = result?.message?.details;
		assert.ok(details?.prepassSafeguardReason, "parse-failure keep-all should surface a fail-open note");
		assert.match(String(details.prepassSafeguardReason), /parse failure/i);

		// The persisted decision carries the flag so analytics can query it.
		await flushLog();
		const logged = readFileSync(logPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		const decision = logged.find((e) => Array.isArray(e.included) && Array.isArray(e.excluded));
		assert.ok(decision, "a PruningDecision row should be logged");
		assert.equal(decision.keptAllDueToParseFailure, true);
	} finally {
		__setCompleteFn(null);
	}
});
