import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, Skill, ToolInfo } from "@earendil-works/pi-coding-agent";
import { clearPruningTrackingForTesting, flushLog, setLogPathForTesting } from "../logger.js";
import { readKeptSkills, clearKeptSkills } from "../../../shared/pruned-skills.js";
import type { PruningConfig } from "../types.js";
import { runAsk } from "../../ask-user/src/ask.js";

installSdkResolverForTests();
const require = createRequire(import.meta.url);
const { default: skillPruner, __setFormatter, __setToolSeams, __setCompleteFn, resetForTesting, setConfigForTesting, getHiddenSkills, recordHiddenSkills, recordPrunedTools, clearCapabilityStateForTesting } = require("../index.ts") as typeof import("../index.js");

function installSdkResolverForTests(): void {
	// Isolate from host extension-toggle state. When tests run inside the
	// running editor, the host exports PIE_EXTENSION_TOGGLES_JSON with
	// skill-pruner disabled, which makes shouldSkipPruning() short-circuit the
	// before_agent_start handler to `undefined` before any pruning runs.
	// These tests drive on/off/auto/shadow via config.mode and never exercise
	// the toggle, so neutralize it for the duration of this test process.
	delete process.env.PIE_EXTENSION_TOGGLES_JSON;

	const mockDir = mkdtempSync(path.join(tmpdir(), "skill-pruner-sdk-mock-"));

	// Mock pi-coding-agent SDK
	const sdkPath = path.join(mockDir, "pi-coding-agent.cjs");
	writeFileSync(sdkPath, "exports.formatSkillsForPrompt = () => { throw new Error('test must call __setFormatter'); };\n", "utf-8");

	// Mock pi-tui
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
		if (request === "@earendil-works/pi-coding-agent") {
			return sdkPath;
		}
		if (request === "@earendil-works/pi-tui") {
			return tuiPath;
		}
		return originalResolveFilename.call(this, request, parent, isMain, options);
	};
}

// ---------------------------------------------------------------------------
// Shared test-double for formatSkillsForPrompt.
// ---------------------------------------------------------------------------
function testFormatSkillsForPrompt(skills: Skill[]): string {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
	if (visibleSkills.length === 0) return "";
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
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
			dependencies: { edit: ["read"], subagent: ["bash"], ...(toolsOverrides?.dependencies ?? {}) },
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

type LifecycleTool = {
	name: string;
	description?: string;
	parameters?: unknown;
	promptGuidelines?: string[];
	execute?: (...args: any[]) => Promise<any>;
};

function registerLifecycleAskUser(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description: "Ask one clarifying question with preset answers and an optional free-form reply.",
		parameters: { type: "object", properties: {} },
		async execute(
			toolCallId: string,
			params: Parameters<typeof runAsk>[0],
			signal: AbortSignal,
			_onUpdate: unknown,
			ctx: { ui: Parameters<typeof runAsk>[1]["ui"] },
		) {
			return runAsk(params, { ui: ctx.ui, signal, toolCallId });
		},
	});
}

function createLifecycleRuntime() {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, LifecycleTool>();
	const activeTools = new Set<string>();
	let stale = false;
	const assertActive = () => {
		if (stale) {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		}
	};
	const pi = {
		on(eventName: string, handler: Handler) {
			assertActive();
			handlers.set(eventName, handler);
		},
		registerMessageRenderer() {
			assertActive();
		},
		registerTool(tool: LifecycleTool) {
			assertActive();
			tools.set(tool.name, tool);
			activeTools.add(tool.name);
		},
		getAllTools() {
			assertActive();
			return [...tools.values()].map((tool) => ({
				name: tool.name,
				description: tool.description ?? "",
				parameters: tool.parameters ?? { type: "object", properties: {} },
				promptGuidelines: tool.promptGuidelines,
			})) as ToolInfo[];
		},
		getActiveTools() {
			assertActive();
			return [...activeTools];
		},
		setActiveTools(names: string[]) {
			assertActive();
			activeTools.clear();
			for (const name of names) activeTools.add(name);
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		handlers,
		tools,
		activeToolNames: () => [...activeTools],
		dispose: () => { stale = true; },
	};
}

function register(configOverride: PruningConfig, logPath = path.join(mkdtempSync(path.join(tmpdir(), "skill-pruner-integration-")), "pruning.jsonl")): RegisterResult {
	resetForTesting();
	clearPruningTrackingForTesting();
	setLogPathForTesting(logPath);
	setConfigForTesting(configOverride);
	__setFormatter(testFormatSkillsForPrompt);
	const handlers = new Map<string, Handler>();
	const registeredTools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }> = new Map();
	const registeredRenderers = new Map<string, (...args: any[]) => any>();
	const pi = {
		on(eventName: string, handler: Handler) {
			handlers.set(eventName, handler);
		},
		registerMessageRenderer(customType: string, renderer: any) {
			registeredRenderers.set(customType, renderer);
		},
		registerTool(toolDef: { name: string; execute?: (...args: unknown[]) => Promise<unknown> }) {
			if (toolDef.execute) {
				registeredTools.set(toolDef.name, toolDef as { execute: (...args: unknown[]) => Promise<unknown> });
			}
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

async function runBeforeAgentStart(handlers: Map<string, Handler>, prompt: string, skills: Skill[], overrideSystemPrompt?: string, sessionId = "session-1"): Promise<BeforeAgentStartReturn> {
	const handler = handlers.get("before_agent_start");
	assert.ok(handler, "before_agent_start handler registered");
	return await handler({
		type: "before_agent_start",
		prompt,
		systemPrompt: overrideSystemPrompt ?? systemPrompt(skills),
		systemPromptOptions: {
			cwd: "/repo",
			skills,
			contextFiles: [{ path: "AGENTS.md", content: "Project context" }],
		},
	}, { cwd: "/repo", sessionManager: { getSessionId: () => sessionId } }) as BeforeAgentStartReturn;
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

// ---------------------------------------------------------------------------
// LLM-based pruning tests (prune-list schema)
// ---------------------------------------------------------------------------

test("discretion mode: LLM prunes a subset → only those skills removed", async () => {
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["duckdb-query-optimization", "frontend-design"] }));
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "Refactor this code for clarity", realisticSkills);

		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /<name>frontend-design<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /Pruned skills|duckdb-query-optimization/);
		assert.ok(getHiddenSkills("session-1").has("duckdb-query-optimization"));
	} finally {
		__setCompleteFn(null);
	}
});

test("empty prune lists for both skills and tools → keep all", async () => {
	__setCompleteFn(mockCompleteFn({ pruneSkills: [], pruneTools: [] }));
	try {
		const { handlers } = register(config({ pinned: ["frontend-design"] }));
		const result = await runBeforeAgentStart(handlers, "simple question", realisticSkills);

		// Empty prune lists = nothing to remove = keep everything (the aligned
		// default; previously an empty inclusion list pruned everything).
		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>frontend-design<\/name>/);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.match(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
	} finally {
		__setCompleteFn(null);
	}
});

test("empty skill prune-list with non-empty tool prune-list keeps all skills (mismatch fixed)", async () => {
	// The original bug: {"skills":[],"tools":[...]} (empty keep-list for skills,
	// non-empty for tools) pruned EVERY skill. Under the prune-list model an empty
	// skill list means "prune no skills" — all skills are kept.
	__setCompleteFn(async () => ({ text: '{"pruneSkills":[],"pruneTools":["web_search"]}' }));
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 10 }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: () => {},
		});
		const result = await runBeforeAgentStart(handlers, "simple question", realisticSkills);

		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.match(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
		assert.match(result.systemPrompt, /<name>frontend-design<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /Pruned skills/);
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("phantom pinned skill (not in visible skills) does not trigger fail-open", async () => {
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["duckdb-query-optimization", "frontend-design"] }));
	try {
		const { handlers } = register(config({ pinned: ["nonexistent-skill"] }));
		const result = await runBeforeAgentStart(handlers, "refactor code", realisticSkills);

		// The pinned skill doesn't exist in the session, so it should be ignored.
		// The LLM's prune of duckdb/frontend should still be honored.
		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
	} finally {
		__setCompleteFn(null);
	}
});

test("ceiling is guidance only: pruning nothing keeps all skills even above the ceiling", async () => {
	__setCompleteFn(mockCompleteFn({ pruneSkills: [], pruneTools: [] }));
	try {
		const { handlers } = register(config({ ceiling: 2 }));
		const result = await runBeforeAgentStart(handlers, "do everything", realisticSkills);

		assert.ok(result?.systemPrompt);
		// 3 skills, ceiling 2, but the LLM pruned nothing → keep all 3 (no hard clamp).
		const matches = result.systemPrompt.match(/<name>[^<]+<\/name>/g) ?? [];
		assert.equal(matches.length, 3, "ceiling is no longer hard-enforced; keep-all is honored");
	} finally {
		__setCompleteFn(null);
	}
});

test("pinned skills protected even when the LLM tries to prune them", async () => {
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

test("alwaysKeep skills and tools protected even when the LLM prunes them", async () => {
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["frontend-design", "duckdb-query-optimization"], pruneTools: ["web_search", "subagent"] }));
	try {
		const { handlers } = register(config(
			{ alwaysKeep: ["frontend-design"] },
			"auto",
			{ ceiling: 2, alwaysKeep: ["web_search"] },
		));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});

		const result = await runBeforeAgentStart(handlers, "refactor code", realisticSkills);
		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>frontend-design<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
		assert.ok(setActiveToolsCalls.length > 0);
		assert.ok(setActiveToolsCalls[0].includes("web_search"), "alwaysKeep web_search protected from pruning");
		assert.ok(!setActiveToolsCalls[0].includes("subagent"), "subagent was pruned");
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("empty prepass response retries with minimal reasoning before failing open", async () => {
	const reasoningLevels: unknown[] = [];
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(async (_model, _context, options) => {
		reasoningLevels.push(options.reasoning);
		if (reasoningLevels.length === 1) {
			return { text: "", stopReason: "aborted", errorMessage: "timeout" };
		}
		return { text: '{"pruneSkills":["duckdb-query-optimization","frontend-design"],"pruneTools":["web_search"]}', stopReason: "stop" };
	});
	try {
		const cfg = config({}, "auto", { ceiling: 10 });
		cfg.thinkingLevel = "high";
		const { handlers } = register(cfg);
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});

		const result = await runBeforeAgentStart(handlers, "refactor code", realisticSkills);
		assert.deepEqual(reasoningLevels, ["high", "minimal"]);
		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
		const feedback = result?.message;
		assert.equal(feedback?.content.startsWith("Kept"), true);
		assert.ok(setActiveToolsCalls[0].includes("read"));
		assert.ok(setActiveToolsCalls[0].includes("edit"));
		assert.ok(!setActiveToolsCalls[0].includes("web_search"));
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("thrown prepass errors also retry with minimal reasoning", async () => {
	const reasoningLevels: unknown[] = [];
	__setCompleteFn(async (_model, _context, options) => {
		reasoningLevels.push(options.reasoning);
		if (reasoningLevels.length === 1) {
			throw new Error("timeout");
		}
		return { text: '{"pruneSkills":["duckdb-query-optimization","frontend-design"],"pruneTools":[]}' };
	});
	try {
		const cfg = config();
		cfg.thinkingLevel = "high";
		const { handlers } = register(cfg);
		const result = await runBeforeAgentStart(handlers, "refactor code", realisticSkills);
		assert.deepEqual(reasoningLevels, ["high", "minimal"]);
		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
	} finally {
		__setCompleteFn(null);
	}
});

test("LLM failure → graceful fallback (all skills included)", async () => {
	__setCompleteFn(async () => { throw new Error("model unavailable"); });
	const origWarn = console.warn;
	const warnings: string[] = [];
	console.warn = (m?: unknown) => { warnings.push(String(m)); };
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "anything", realisticSkills);

		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.match(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
		assert.match(result.systemPrompt, /<name>frontend-design<\/name>/);
		assert.ok(warnings.some((w) => w.includes("LLM pruning failed")));
	} finally {
		console.warn = origWarn;
		__setCompleteFn(null);
	}
});

test("empty skills array produces no modification", async () => {
	__setCompleteFn(mockCompleteFn({ pruneSkills: [], pruneTools: [] }));
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "anything", [], "Base prompt without skills");
		assert.equal(result, undefined);
	} finally {
		__setCompleteFn(null);
	}
});

test("regex no-match case fails open with original prompt unchanged", async () => {
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["duckdb-query-optimization"] }));
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "Refactor code", realisticSkills, "Base prompt without the skills block");
		assert.equal(result, undefined);
	} finally {
		__setCompleteFn(null);
	}
});

test("skills block absent but tools pruned → decision logs tool pruning, skills reported as keep-all", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "skill-pruner-integration-"));
	const logPath = path.join(dir, "pruning.jsonl");
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["duckdb-query-optimization"], pruneTools: ["web_search"] }));
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 10 }), logPath);
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: () => {},
		});
		// systemPrompt WITHOUT the skills block → skill pruning can't apply.
		await runBeforeAgentStart(handlers, "edit code", realisticSkills, "Base prompt without the skills block");
		await flushLog();

		const lines = readFileSync(logPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		const decision = lines.find((l) => Array.isArray(l.included) && Array.isArray(l.excluded));
		assert.ok(decision, "a decision row should be logged because tools were pruned");
		// Skills were NOT pruned (block absent) → excluded empty, included = all visible
		// (must match recordKnownSkills, which tracks zero pruned skills).
		assert.deepEqual(decision.excluded, []);
		assert.ok(decision.included.includes("code-simplification"));
		assert.ok(decision.included.includes("duckdb-query-optimization"));
		// Tool pruning WAS applied and is logged.
		assert.deepEqual(decision.toolExcluded, ["web_search"]);
		assert.ok(decision.toolIncluded.includes("read"));
		// Skill pruning self-disabled (skills block absent) → a warning event is
		// logged so the silent disable is auditable, not just a console.warn.
		assert.ok(
			lines.some((l) => l.event === "skills_block_not_found"),
			"skills_block_not_found warning should be logged when the skills block is expected but absent",
		);
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
		setLogPathForTesting(null);
		clearPruningTrackingForTesting();
	}
});

test("tool pruning keeps dependencies of kept tools", async () => {
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["duckdb-query-optimization", "frontend-design"], pruneTools: ["web_search"] }));
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 2, dependencies: { edit: ["read"], subagent: ["bash"] } }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});
		await runBeforeAgentStart(handlers, "edit and delegate", realisticSkills);
		assert.ok(setActiveToolsCalls.length > 0);
		const active = setActiveToolsCalls[0];
		assert.ok(active.includes("edit"));
		assert.ok(active.includes("read"), "read is kept (dependency of kept edit)");
		assert.ok(active.includes("subagent"));
		assert.ok(active.includes("bash"), "bash is kept (dependency of kept subagent)");
		assert.ok(!active.includes("web_search"), "web_search was pruned");
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("shadow mode leaves prompt unchanged and logs decision", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "skill-pruner-integration-"));
	const logPath = path.join(dir, "pruning.jsonl");
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["duckdb-query-optimization", "frontend-design"] }));
	try {
		const { handlers } = register(config({}, "shadow"), logPath);
		const originalPrompt = systemPrompt(realisticSkills);
		const result = await runBeforeAgentStart(handlers, "Refactor this code for clarity", realisticSkills, originalPrompt);

		assert.equal(result?.systemPrompt, originalPrompt);
		await flushLog();

		const lines = readFileSync(logPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(lines[0].mode, "shadow");
		assert.equal(typeof lines[0].sessionPath, "string");
		assert.ok(lines[0].excluded.includes("duckdb-query-optimization"));
	} finally {
		__setCompleteFn(null);
		setLogPathForTesting(null);
		clearPruningTrackingForTesting();
	}
});

test("shadow mode: skill read of pruned skill → shadow_miss_candidate", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "skill-pruner-integration-"));
	const logPath = path.join(dir, "pruning.jsonl");
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["duckdb-query-optimization", "frontend-design"] }));
	try {
		const { handlers } = register(config({}, "shadow"), logPath);
		await runBeforeAgentStart(handlers, "Refactor this code for clarity", realisticSkills);

		const toolHandler = handlers.get("tool_call");
		assert.ok(toolHandler);
		await toolHandler({
			type: "tool_call", toolCallId: "1", toolName: "read",
			input: { path: "/repo/skills/duckdb-query-optimization/SKILL.md" },
		}, { cwd: "/repo", sessionManager: { getSessionId: () => "session-1" } });
		await flushLog();

		const lines = readFileSync(logPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(lines.some((line) => line.event === "shadow_miss_candidate" && line.skillName === "duckdb-query-optimization"));
	} finally {
		__setCompleteFn(null);
		setLogPathForTesting(null);
		clearPruningTrackingForTesting();
	}
});

test("auto mode: pruned skill read → skill_miss; included skill read → skill_read", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "skill-pruner-integration-"));
	const logPath = path.join(dir, "pruning.jsonl");
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["duckdb-query-optimization", "frontend-design"] }));
	try {
		const { handlers } = register(config(), logPath);
		await runBeforeAgentStart(handlers, "Refactor this code for clarity", realisticSkills);

		const toolHandler = handlers.get("tool_call");
		assert.ok(toolHandler);

		await toolHandler({
			type: "tool_call", toolCallId: "1", toolName: "read",
			input: { path: "/repo/skills/duckdb-query-optimization/SKILL.md" },
		}, { cwd: "/repo", sessionManager: { getSessionId: () => "session-1" } });

		await toolHandler({
			type: "tool_call", toolCallId: "2", toolName: "read",
			input: { path: "/repo/skills/code-simplification/SKILL.md" },
		}, { cwd: "/repo", sessionManager: { getSessionId: () => "session-1" } });
		await flushLog();

		const lines = readFileSync(logPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(lines.some((line) => line.event === "skill_miss" && line.skillName === "duckdb-query-optimization"));
		assert.ok(lines.some((line) => line.event === "skill_read" && line.skillName === "code-simplification"));
	} finally {
		__setCompleteFn(null);
		setLogPathForTesting(null);
		clearPruningTrackingForTesting();
	}
});

test("disabled skill excluded from LLM consideration", async () => {
	const disabledSkill = skill("disabled-helper", "Use when disabled things happen.", { disableModelInvocation: true });
	const enabledSkills = [
		skill("alpha-tool", "Use when alpha beta."),
		skill("gamma-tool", "Use when gamma delta."),
	];
	const allSkills = [disabledSkill, ...enabledSkills];

	__setCompleteFn(mockCompleteFn({ pruneSkills: [] }));
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "alpha beta", allSkills);

		assert.ok(result?.systemPrompt);
		assert.doesNotMatch(result.systemPrompt, /<name>disabled-helper<\/name>/);
		assert.match(result.systemPrompt, /<name>alpha-tool<\/name>/);
		assert.match(result.systemPrompt, /<name>gamma-tool<\/name>/);
	} finally {
		__setCompleteFn(null);
	}
});

test("queued steering messages bypass the pruning prepass", async () => {
	const { handlers } = register(config());
	const input = handlers.get("input");
	assert.ok(input);
	assert.deepEqual(await input({
		type: "input",
		text: "small correction",
		source: "rpc",
		streamingBehavior: "steer",
	}, {}), { action: "continue" });

	const result = await runBeforeAgentStart(handlers, "small correction", realisticSkills);
	assert.equal(result, undefined, "queued steering must not run the prepass or return a message");
});

test("unexpected prepass error (registry throw) fails open: nothing pruned, error surfaced", async () => {
	__setCompleteFn(async () => ({ text: '{"pruneSkills":[],"pruneTools":[]}' }));
	const setActiveToolsCalls: string[][] = [];
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 10 }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});
		const handler = handlers.get("before_agent_start");
		assert.ok(handler, "before_agent_start handler registered");

		// modelRegistry.find throws → resolveModel throws inside runPruningPrepass.
		// The prepass must catch it and fail open rather than rejecting the hook.
		const result = await handler({
			type: "before_agent_start",
			prompt: "Refactor this code for clarity",
			systemPrompt: systemPrompt(realisticSkills),
			systemPromptOptions: { cwd: "/repo", skills: realisticSkills, contextFiles: [{ path: "AGENTS.md", content: "" }] },
		}, {
			cwd: "/repo",
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: { find: () => { throw new Error("registry boom"); } },
		}) as BeforeAgentStartReturn;

		// Fail-open: every skill is still in the prompt, no tools were pruned.
		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.match(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
		assert.match(result.systemPrompt, /<name>frontend-design<\/name>/);
		assert.equal(setActiveToolsCalls.length, 0, "no tools pruned on prepass failure");
		// The error is surfaced transparently as a pruning-result message.
		const feedback = result?.message;
		assert.ok(feedback, "error surfaced as a feedback message");
		assert.match(String(feedback.details.prepassError), /registry boom/);
		assert.deepEqual(feedback.details.excludedSkills, []);
		assert.deepEqual(feedback.details.excludedTools, []);
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("recent conversation from the session is fed to the prepass so follow-ups get context", async () => {
	let capturedUserMessage = "";
	__setCompleteFn(async (_model: unknown, context: Array<{ role: string; content: string }>) => {
		const userMsg = context.find((m) => m.role === "user");
		capturedUserMessage = userMsg?.content ?? "";
		return { text: '{"pruneSkills":[],"pruneTools":[]}' };
	});
	try {
		const { handlers } = register(config());
		const handler = handlers.get("before_agent_start");
		assert.ok(handler, "before_agent_start handler registered");

		// Simulate prior turns persisted in the session. Leaf = last assistant turn;
		// the current "Fix this" prompt is supplied via event.prompt (not persisted),
		// so it is excluded from the walk and only prior turns are surfaced.
		const entries = [
			{ id: "m1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "Make a pass over the pruner for robustness" }] } },
			{ id: "m2", parentId: "m1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Reviewing the extension" }, { type: "tool_use", name: "read" }] } },
			{ id: "m3", parentId: "m2", type: "message", message: { role: "user", content: [{ type: "text", text: "Leave it uncommitted" }] } },
			{ id: "m4", parentId: "m3", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Got it" }] } },
		];
		const byId = new Map(entries.map((e) => [e.id, e]));

		await handler({
			type: "before_agent_start",
			prompt: "Fix this",
			systemPrompt: systemPrompt(realisticSkills),
			systemPromptOptions: { cwd: "/repo", skills: realisticSkills, contextFiles: [{ path: "AGENTS.md", content: "" }] },
		}, {
			cwd: "/repo",
			sessionManager: {
				getSessionId: () => "session-1",
				getSessionFile: () => undefined,
				getLeafEntry: () => entries[entries.length - 1],
				getEntry: (id: string) => byId.get(id),
			},
		});

		assert.ok(capturedUserMessage.includes("Recent conversation"), "prepass user message includes recent conversation");
		assert.ok(capturedUserMessage.includes("Make a pass over the pruner"), "prior user turn is surfaced");
		assert.ok(capturedUserMessage.includes("Fix this"), "current prompt is still present");
	} finally {
		__setCompleteFn(null);
	}
});

test("always-keep / pinned skills and tools are never sent to the prepass", async () => {
	// The user's never-prune list (skills.alwaysKeep + pinned, and
	// tools.alwaysKeep) must not even reach the prepass LLM: surfacing them only
	// to re-protect them afterward wastes tokens and asks the model to reason
	// about items it cannot prune. Capture the user message the prepass
	// actually receives and assert the protected names are absent (by both name
	// and description) while the prunable candidates are present, and that there
	// is no "Protected …" framing line at all.
	let capturedUserMessage = "";
	__setCompleteFn(async (_model: unknown, context: Array<{ role: string; content: string }>) => {
		const userMsg = context.find((m) => m.role === "user");
		capturedUserMessage = userMsg?.content ?? "";
		return { text: '{"pruneSkills":[],"pruneTools":[]}' };
	});
	try {
		const { handlers } = register(config(
			{ alwaysKeep: ["frontend-design"], pinned: ["code-simplification"] },
			"auto",
			{ ceiling: 10, alwaysKeep: ["web_search"] },
		));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: () => {},
		});
		const result = await runBeforeAgentStart(handlers, "refactor code", realisticSkills);

		// Prunable candidates are still presented to the model...
		assert.ok(capturedUserMessage.includes("duckdb-query-optimization"), "prunable skill is a candidate");
		assert.ok(capturedUserMessage.includes("Candidate tools:"));
		// ...but every protected (never-prune) item is absent, by name AND by
		// description, and there is no "Protected …" framing line anywhere.
		assert.ok(!capturedUserMessage.includes("frontend-design"), "alwaysKeep skill name not surfaced to prepass");
		assert.ok(!capturedUserMessage.includes("Production-grade frontend interfaces"), "alwaysKeep skill description not surfaced to prepass");
		assert.ok(!capturedUserMessage.includes("code-simplification"), "pinned skill name not surfaced to prepass");
		assert.ok(!capturedUserMessage.includes("web_search"), "alwaysKeep tool name not surfaced to prepass");
		assert.ok(!/Protected (skills|tools)/.test(capturedUserMessage), "no protected-list framing in prepass prompt");

		// And the protected items still survive in the rewritten system prompt
		// (re-added downstream by applySkillSelection / applyToolSelection).
		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>frontend-design<\/name>/);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("off mode baseline: known skill read → skill_read; non-skill read → no event", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "skill-pruner-integration-"));
	const logPath = path.join(dir, "pruning.jsonl");
	try {
		const { handlers } = register(config({}, "off"), logPath);
		await runBeforeAgentStart(handlers, "anything", realisticSkills);

		const toolHandler = handlers.get("tool_call");
		assert.ok(toolHandler);

		await toolHandler({
			type: "tool_call", toolCallId: "1", toolName: "read",
			input: { path: "/repo/skills/code-simplification/SKILL.md" },
		}, { cwd: "/repo", sessionManager: { getSessionId: () => "session-1" } });

		await toolHandler({
			type: "tool_call", toolCallId: "2", toolName: "read",
			input: { path: "/repo/src/index.ts" },
		}, { cwd: "/repo", sessionManager: { getSessionId: () => "session-1" } });
		await flushLog();

		const lines = readFileSync(logPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(lines.some((line) => line.event === "skill_read" && line.skillName === "code-simplification"));
		assert.ok(!lines.some((line) => line.skillName === "src/index" || line.skillName === "index"));
	} finally {
		setLogPathForTesting(null);
		clearPruningTrackingForTesting();
	}
});

test("tool_call safely ignores read events with non-string path", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "skill-pruner-integration-"));
	const logPath = path.join(dir, "pruning.jsonl");
	try {
		const { handlers } = register(config({}, "off"), logPath);
		await runBeforeAgentStart(handlers, "anything", realisticSkills);

		const toolHandler = handlers.get("tool_call");
		assert.ok(toolHandler);
		await toolHandler({
			type: "tool_call", toolCallId: "1", toolName: "read",
			input: { path: 123 },
		}, { cwd: "/repo", sessionManager: { getSessionId: () => "session-1" } });

		assert.equal(existsSync(logPath), false);
	} finally {
		setLogPathForTesting(null);
		clearPruningTrackingForTesting();
	}
});

test("tool_call catches unexpected context errors and continues", async () => {
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (m?: unknown) => { warnings.push(String(m)); };
	try {
		const { handlers } = register(config({}, "off"));
		await runBeforeAgentStart(handlers, "anything", realisticSkills);
		const toolHandler = handlers.get("tool_call");
		assert.ok(toolHandler);

		await toolHandler({
			type: "tool_call", toolCallId: "1", toolName: "read",
			input: { path: "/repo/skills/code-simplification/SKILL.md" },
		}, {
			cwd: "/repo",
			sessionManager: { getSessionId() { throw new Error("boom"); } },
		});

		assert.ok(warnings.some((warning) => warning.includes("failed to record skill read: boom")));
	} finally {
		console.warn = originalWarn;
	}
});

test("tool pruning in auto mode calls setActiveTools with the kept tools", async () => {
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["duckdb-query-optimization", "frontend-design"], pruneTools: ["web_search"] }));
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 10 }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});
		await runBeforeAgentStart(handlers, "edit some code", realisticSkills);
		assert.ok(setActiveToolsCalls.length > 0, "setActiveTools should have been called");
		assert.ok(setActiveToolsCalls[0].includes("read"));
		assert.ok(setActiveToolsCalls[0].includes("edit"));
		assert.ok(!setActiveToolsCalls[0].includes("web_search"));
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("tool pruning in shadow mode does not call setActiveTools", async () => {
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["duckdb-query-optimization"], pruneTools: ["web_search"] }));
	try {
		const { handlers } = register(config({}, "shadow", { ceiling: 10 }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});
		await runBeforeAgentStart(handlers, "edit some code", realisticSkills);
		assert.equal(setActiveToolsCalls.length, 0, "setActiveTools should NOT be called in shadow mode");
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("tool pruning without tools config does not call setActiveTools", async () => {
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["duckdb-query-optimization"] }));
	try {
		const { handlers } = register(config()); // no tools config
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});
		await runBeforeAgentStart(handlers, "edit some code", realisticSkills);
		assert.equal(setActiveToolsCalls.length, 0);
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("request_capability keeps its owning session context after a subagent runtime is disposed", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "skill-pruner-lifecycle-"));
	const logPath = path.join(dir, "pruning.jsonl");
	resetForTesting();
	clearPruningTrackingForTesting();
	setLogPathForTesting(logPath);
	setConfigForTesting(config({}, "auto", { ceiling: 3 }));
	__setFormatter(testFormatSkillsForPrompt);
	__setCompleteFn(async () => ({ text: '{"keep":[]}' }));

	try {
		// The main runtime starts with ask_user available, then the pruning turn
		// hides it while retaining the hard-protected recovery tool.
		const main = createLifecycleRuntime();
		registerLifecycleAskUser(main.pi);
		skillPruner(main.pi);
		assert.ok(main.activeToolNames().includes("ask_user"), "ask_user starts active");

		const beforeAgentStart = main.handlers.get("before_agent_start");
		assert.ok(beforeAgentStart);
		await beforeAgentStart({
			type: "before_agent_start",
			prompt: "Delegate a review, then ask the user which fix to apply",
			systemPrompt: "Base prompt.",
			systemPromptOptions: {
				cwd: "/repo",
				skills: [],
				contextFiles: [],
				selectedTools: main.activeToolNames(),
			},
		}, {
			cwd: "/repo",
			sessionManager: { getSessionId: () => "main-session", getSessionFile: () => "/sessions/main.jsonl" },
		});
		assert.ok(!main.activeToolNames().includes("ask_user"), "ask_user is pruned from the main runtime");
		assert.ok(main.activeToolNames().includes("request_capability"));

		// In-process subagents load the same cached extension module with their own
		// pi API. Their teardown invalidates that API. This is the lifecycle that
		// used to overwrite the process-global skill-pruner facade and strand the
		// still-live main session on the disposed child's stale context.
		const child = createLifecycleRuntime();
		registerLifecycleAskUser(child.pi);
		skillPruner(child.pi);
		const childRecovery = child.tools.get("request_capability");
		assert.ok(childRecovery?.execute);
		const childList = await childRecovery.execute(
			"child-list",
			{},
			undefined,
			undefined,
			{ sessionManager: { getSessionId: () => "child-session" } },
		);
		assert.equal(childList.content[0].text, "No capabilities are hidden by the latest pruning decision.",
			"capability state remains isolated between unrelated sessions");
		child.dispose();

		const mainRecovery = main.tools.get("request_capability");
		assert.ok(mainRecovery?.execute);
		const listed = await mainRecovery.execute(
			"main-list",
			{},
			undefined,
			undefined,
			{ sessionManager: { getSessionId: () => "main-session" } },
		);
		assert.equal(listed.content[0].text, "tools\task_user\nskills\t(none)");

		const activated = await mainRecovery.execute(
			"main-activate",
			{ capabilityType: "tool", capabilityName: "ask_user" },
			undefined,
			undefined,
			{ sessionManager: { getSessionId: () => "main-session" } },
		);
		assert.match(activated.content[0].text, /Enabled tool 'ask_user'/);
		assert.ok(main.activeToolNames().includes("ask_user"), "activation mutates the current main runtime");

		// Invoke the recovered ask_user fixture through the production runAsk
		// implementation and the main execution context. A stale child UI would
		// throw; the current UI answers.
		const ask = main.tools.get("ask_user");
		assert.ok(ask?.execute);
		const uiCalls: Array<{ title: string; toolCallId?: string }> = [];
		const answer = await ask.execute(
			"ask-current",
			{ question: "Which fix?", options: ["Root cause", "Workaround"], allowCustom: false },
			new AbortController().signal,
			undefined,
			{
				ui: {
					select: async (title: string, _options: string[], options?: { toolCallId?: string }) => {
						uiCalls.push({ title, toolCallId: options?.toolCallId });
						return "Root cause";
					},
					input: async () => { throw new Error("custom input should not open"); },
				},
			},
		);
		assert.equal(answer.content[0].text, "Root cause");
		assert.deepEqual(uiCalls, [{ title: "Which fix?", toolCallId: "ask-current" }]);
	} finally {
		__setCompleteFn(null);
		setLogPathForTesting(null);
		clearPruningTrackingForTesting();
		resetForTesting();
	}
});

test("request_capability enables a hidden tool and logs recovery", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "skill-pruner-integration-"));
	const logPath = path.join(dir, "pruning.jsonl");
	const { registeredTools } = register(config({}, "auto", { ceiling: 3 }), logPath);
	const toolDef = registeredTools.get("request_capability");
	assert.ok(toolDef);
	let activated: string[] = [];
	__setToolSeams({ getAllTools: () => mockToolInfo as any[], getActiveTools: () => ["read", "edit", "bash"], setActiveTools: (names) => { activated = names; } });
	try {
		recordPrunedTools("session-1", ["web_search"]);
		const result = await toolDef.execute("call-1", { capabilityType: "tool", capabilityName: "web_search" }, undefined, undefined, { sessionManager: { getSessionId: () => "session-1" } }) as any;
		assert.ok(result.content[0].text.includes("web_search"));
		assert.ok(activated.includes("web_search"));
		await flushLog();
		const lines = readFileSync(logPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(lines.some((line) => line.event === "tool_recovered" && line.toolName === "web_search"));
	} finally {
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
		setLogPathForTesting(null);
	}
});

test("request_capability poll lists only names hidden by the latest decision", async () => {
	const { registeredTools } = register(config({}, "auto", { ceiling: 3 }));
	const toolDef = registeredTools.get("request_capability");
	assert.ok(toolDef);
	__setToolSeams({ getAllTools: () => mockToolInfo as any[], getActiveTools: () => ["read", "edit", "bash"], setActiveTools: () => {} });
	try {
		recordPrunedTools("session-list", ["web_search"]);
		const result = await toolDef.execute("call-list", {}, undefined, undefined, { sessionManager: { getSessionId: () => "session-list" } }) as any;
		assert.equal(result.content[0].text, "tools\tweb_search\nskills\t(none)");
	} finally {
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("request_capability loads a hidden trusted skill immediately", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "skill-recovery-"));
	const filePath = path.join(dir, "SKILL.md");
	writeFileSync(filePath, "---\nname: hidden-skill\ndescription: hidden\n---\n\n# Secret procedure\n\nFollow this exactly.\n");
	const skill = { name: "hidden-skill", description: "hidden", filePath, baseDir: dir, source: "test" } as Skill;
	const logPath = path.join(dir, "pruning.jsonl");
	const { registeredTools } = register(config(), logPath);
	const toolDef = registeredTools.get("request_capability");
	assert.ok(toolDef);
	try {
		recordHiddenSkills("session-skill", [skill]);
		const result = await toolDef.execute("call-skill", { capabilityType: "skill", capabilityName: "hidden-skill" }, undefined, undefined, { sessionManager: { getSessionId: () => "session-skill" } }) as any;
		assert.match(result.content[0].text, /<skill name="hidden-skill"/);
		assert.match(result.content[0].text, /Follow this exactly/);
		assert.doesNotMatch(result.content[0].text, /description: hidden/);
		await flushLog();
		const lines = readFileSync(logPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(lines.some((line) => line.event === "skill_recovered" && line.skillName === "hidden-skill"));
	} finally {
		setLogPathForTesting(null);
		clearCapabilityStateForTesting();
	}
});

test("request_capability rejects an unknown exact name", async () => {
	const { registeredTools } = register(config({}, "auto", { ceiling: 3 }));
	const toolDef = registeredTools.get("request_capability");
	assert.ok(toolDef);
	__setToolSeams({ getAllTools: () => mockToolInfo as any[], getActiveTools: () => ["read", "edit", "bash"], setActiveTools: () => {} });
	try {
		const result = await toolDef.execute("call-2", { capabilityType: "tool", capabilityName: "nonexistent_tool" }, undefined, undefined, { sessionManager: { getSessionId: () => "session-unknown" } }) as any;
		assert.equal(result.isError, true);
	} finally {
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("UI feedback message is returned when skills are pruned", async () => {
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["duckdb-query-optimization", "frontend-design"] }));
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "Refactor this code for clarity", realisticSkills);
		const feedback = result?.message;
		assert.ok(feedback, "should return a feedback message");
		assert.equal(feedback.customType, "pruning-result");
		assert.equal(feedback.display, true);
		const details = feedback.details;
		assert.ok(details.excludedSkills.length > 0);
		assert.ok(details.includedSkills.length > 0);
		assert.equal(details.mode, "auto");
	} finally {
		__setCompleteFn(null);
	}
});

test("identical second prompt reuses prepass and marks feedback plus JSONL as cached", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "skill-pruner-integration-"));
	const logPath = path.join(dir, "pruning.jsonl");
	let calls = 0;
	__setCompleteFn(async () => {
		calls++;
		return { text: '{"pruneSkills":["frontend-design"],"pruneTools":[]}' };
	});
	try {
		const { handlers } = register(config(), logPath);
		await runBeforeAgentStart(handlers, "Refactor this code", realisticSkills);
		const secondResult = await runBeforeAgentStart(handlers, "Refactor this code", realisticSkills);
		assert.equal(calls, 1);
		const secondEntry = secondResult?.message;
		assert.equal(secondEntry.details.cacheHit, true);
		assert.match(secondEntry.content, /· cached/);
		assert.equal(secondEntry.details.prepassLatencyMs, 0);
		await flushLog();
		const decisions = readFileSync(logPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(decisions.at(-1).cacheHit, true);
		assert.equal(decisions.at(-1).llmLatencyMs, 0);
	} finally {
		__setCompleteFn(null);
		setLogPathForTesting(null);
	}
});

test("cross-session cache: a second session reuses the first session's exact decision without an LLM call", async () => {
	let calls = 0;
	__setCompleteFn(async () => {
		calls++;
		return { text: '{"pruneSkills":["frontend-design"],"pruneTools":[]}' };
	});
	try {
		const { handlers } = register(config());
		// Session 1: runs the prepass (LLM call) and caches it cross-session.
		const first = await runBeforeAgentStart(handlers, "Refactor this code", realisticSkills, undefined, "session-1");
		assert.equal(calls, 1);
		assert.ok(first?.systemPrompt);
		assert.match(first.systemPrompt, /<name>code-simplification<\/name>/);
		assert.doesNotMatch(first.systemPrompt, /<name>frontend-design<\/name>/);

		// Session 2: same prompt + same catalog → cross-session exact hit. The
		// per-session cache misses (different sessionId), so the cross-session
		// cache supplies the decision — no second LLM call.
		const second = await runBeforeAgentStart(handlers, "Refactor this code", realisticSkills, undefined, "session-2");
		assert.equal(calls, 1, "session 2 must reuse the cross-session cache without an LLM call");
		assert.ok(second?.systemPrompt);
		assert.match(second.systemPrompt, /<name>code-simplification<\/name>/);
		assert.doesNotMatch(second.systemPrompt, /<name>frontend-design<\/name>/);
		const feedback = second?.message;
		assert.equal(feedback.details.cacheHit, true);
		assert.equal(feedback.details.prepassLatencyMs, 0);
	} finally {
		__setCompleteFn(null);
	}
});

test("cross-session cache: a continuation prompt in a second session does NOT reuse the first session's decision", async () => {
	// Privacy: "continue" is context-dependent. Session 2's "continue" must not
	// pull in session 1's cross-session-cached decision (which was for a
	// different prompt). It must run its own prepass.
	let calls = 0;
	__setCompleteFn(async () => {
		calls++;
		return { text: '{"pruneSkills":["frontend-design"],"pruneTools":[]}' };
	});
	try {
		const { handlers } = register(config());
		await runBeforeAgentStart(handlers, "Refactor this code", realisticSkills, undefined, "session-1");
		assert.equal(calls, 1);
		// Session 2 sends "continue" — not an exact match for session 1's prompt, so
		// the cross-session cache (exact-only) must miss and run a fresh prepass.
		await runBeforeAgentStart(handlers, "continue", realisticSkills, undefined, "session-2");
		assert.equal(calls, 2, "continuation prompts must not hit the cross-session cache");
	} finally {
		__setCompleteFn(null);
	}
});

test("autoSkipBelowTokens restores tools pruned by the prior turn without an LLM call or error feedback", async () => {
	let calls = 0;
	const setActiveToolsCalls: string[][] = [];
	let activeTools = mockToolInfo.map((tool) => tool.name);
	__setCompleteFn(async () => { calls++; return { text: '{"pruneSkills":[],"pruneTools":["web_search"]}' }; });
	try {
		const cfg = config({}, "auto", { ceiling: 10 });
		const { handlers } = register(cfg);
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => activeTools,
			setActiveTools: (names: string[]) => {
				activeTools = names;
				setActiveToolsCalls.push(names);
			},
		});
		await runBeforeAgentStart(handlers, "Refactor this code", realisticSkills);
		assert.equal(calls, 1);
		assert.ok(!setActiveToolsCalls[0].includes("web_search"));

		const skipConfig = config({}, "auto", { ceiling: 10 });
		skipConfig.autoSkipBelowTokens = 1_000_000;
		setConfigForTesting(skipConfig);
		const result = await runBeforeAgentStart(handlers, "A different small task", realisticSkills);
		assert.equal(calls, 1);
		assert.equal(result, undefined);
		assert.ok(setActiveToolsCalls.at(-1)?.includes("web_search"));
		assert.equal(readKeptSkills("session-1"), "keep-all");
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
		clearKeptSkills("session-1");
	}
});

test("all skill and tool prompt entries disabled skips the LLM prepass", async () => {
	let calls = 0;
	__setCompleteFn(async () => {
		calls++;
		return { text: '{"pruneSkills":[],"pruneTools":[]}' };
	});
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 10 }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => [],
			setActiveTools: () => { throw new Error("must not re-enable manually disabled tools"); },
		});
		const handler = handlers.get("before_agent_start");
		assert.ok(handler);
		recordPrunedTools("session-empty", ["web_search"]);
		const result = await handler({
			type: "before_agent_start",
			prompt: "Refactor this code",
			systemPrompt: "",
			systemPromptOptions: { cwd: "/repo", skills: [], selectedTools: [], contextFiles: [] },
		}, { cwd: "/repo", sessionManager: { getSessionId: () => "session-empty" } });
		assert.equal(result, undefined);
		assert.equal(calls, 0);
		assert.equal(readKeptSkills("session-empty"), "keep-all");
	} finally {
		clearKeptSkills("session-empty");
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("disabled Tools prompt still permits skill-only pruning without re-enabling tools", async () => {
	let calls = 0;
	__setCompleteFn(async (_model, context) => {
		calls++;
		assert.doesNotMatch(JSON.stringify(context), /web_search/);
		return { text: '{"pruneSkills":["frontend-design"],"pruneTools":[]}' };
	});
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 10 }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => [],
			setActiveTools: () => { throw new Error("must not re-enable manually disabled tools"); },
		});
		const handler = handlers.get("before_agent_start");
		assert.ok(handler);
		const result = await handler({
			type: "before_agent_start",
			prompt: "Refactor this frontend",
			systemPrompt: systemPrompt(realisticSkills),
			systemPromptOptions: { cwd: "/repo", skills: realisticSkills, selectedTools: [], contextFiles: [] },
		}, { cwd: "/repo", sessionManager: { getSessionId: () => "session-skills-only" } }) as BeforeAgentStartReturn;
		assert.equal(calls, 1);
		assert.ok(result?.systemPrompt);
		assert.doesNotMatch(result!.systemPrompt!, /<name>frontend-design<\/name>/);
	} finally {
		clearKeptSkills("session-skills-only");
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("feedback message returned even when nothing is pruned (LLM prunes nothing)", async () => {
	__setCompleteFn(mockCompleteFn({ pruneSkills: [], pruneTools: [] }));
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "do everything", realisticSkills);
		const feedback = result?.message;
		assert.ok(feedback, "feedback message always returned for transparency");
		assert.equal(feedback.customType, "pruning-result");
		assert.equal(feedback.details.excludedSkills.length, 0);
	} finally {
		__setCompleteFn(null);
	}
});

test("message renderer compact view renders skill summary", async () => {
	const { registeredRenderers } = register(config());
	const renderer = registeredRenderers.get("pruning-result");
	assert.ok(renderer);

	const themeMock = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
	};

	const box = renderer(
		{
			content: "Pruned",
			display: true,
			details: {
				includedSkills: ["code-simplification"],
				excludedSkills: ["duckdb-query-optimization", "frontend-design"],
				includedTools: [],
				excludedTools: [],
				mode: "auto",
				skillTokensSaved: 300,
				toolTokensSaved: 0,
			},
		},
		{ expanded: false },
		themeMock,
	);
	const rendered = box.render(80);
	assert.ok(rendered.some((line: string) => line.includes("Kept 1/3 skills")));
});

test("message renderer expanded view renders skill details", async () => {
	const { registeredRenderers } = register(config());
	const renderer = registeredRenderers.get("pruning-result");
	assert.ok(renderer);

	const themeMock = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
	};

	const box = renderer(
		{
			content: "Pruned",
			display: true,
			details: {
				includedSkills: ["code-simplification"],
				excludedSkills: ["duckdb-query-optimization", "frontend-design"],
				includedTools: ["read", "edit"],
				excludedTools: ["web_search"],
				mode: "shadow",
				skillTokensSaved: 200,
				toolTokensSaved: 50,
			},
		},
		{ expanded: true },
		themeMock,
	);
	const rendered = box.render(80);
	const allText = rendered.join("\n");
	assert.ok(allText.includes("code-simplification"));
	assert.ok(allText.includes("duckdb-query-optimization"));
	assert.ok(allText.includes("web_search"));
});

test("message renderer with no details renders raw content", async () => {
	const { registeredRenderers } = register(config());
	const renderer = registeredRenderers.get("pruning-result");
	assert.ok(renderer);

	const themeMock = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
	};

	const box = renderer(
		{ content: "Plain pruning message", display: true },
		{ expanded: false },
		themeMock,
	);
	const rendered = box.render(80);
	assert.ok(rendered.some((line: string) => line.includes("Plain pruning message")));
});

test("no completeFn available → error message returned (no prompt modification)", async () => {
	__setCompleteFn(null);
	const { handlers } = register(config());
	const result = await runBeforeAgentStart(handlers, "Refactor code", realisticSkills);
	const feedback = result?.message;
	assert.ok(feedback, "should return an error message");
	assert.equal(feedback.customType, "pruning-result");
	assert.ok(String(feedback.content).includes("No completion function available"));
	assert.equal(result?.systemPrompt, undefined);
});

test("github-copilot model without headers: copilot headers injected via model registry", async () => {
	// Simulate the real scenario: modelRegistry returns a custom model with headers=undefined
	// (because models.json parseModels() sets headers=undefined). The skill-pruner should
	// patch the model with required copilot headers so the LLM call succeeds.
	let capturedModel: unknown = null;
	let capturedOptions: Record<string, unknown> = {};

	// CompleteFn that captures what model and options were passed
	const captureCompleteFn = async (model: unknown, _context: unknown, options: Record<string, unknown>) => {
		capturedModel = model;
		capturedOptions = options;
		return { text: JSON.stringify({ pruneSkills: [], pruneTools: [] }) };
	};

	__setCompleteFn(captureCompleteFn);
	try {
		const { handlers } = register(config());

		// Context with a modelRegistry that returns a custom model WITHOUT headers
		const ctx = {
			cwd: "/repo",
			sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined },
			modelRegistry: {
				find: (_provider: string, _id: string) => ({
					id: "gpt-5-mini",
					provider: "github-copilot",
					api: "openai-responses",
					baseUrl: "https://api.individual.githubcopilot.com",
					headers: undefined, // This is the bug scenario: custom model has no headers
				}),
				getApiKeyAndHeaders: (_model: unknown) => Promise.resolve({ ok: true, apiKey: "test-key", headers: undefined }),
			},
		};

		const handler = handlers.get("before_agent_start");
		assert.ok(handler, "before_agent_start handler registered");

		await handler({
			type: "before_agent_start",
			prompt: "Refactor this code",
			systemPrompt: systemPrompt(realisticSkills),
			systemPromptOptions: { cwd: "/repo", skills: realisticSkills, contextFiles: [{ path: "AGENTS.md", content: "" }] },
		}, ctx);

		// Verify the model was patched with copilot headers
		const patchedModel = capturedModel as Record<string, unknown> | null;
		assert.ok(patchedModel, "model was captured");
		assert.ok(patchedModel.headers, "model should have headers after patching");
		const headers = patchedModel.headers as Record<string, string>;
		assert.ok(headers["Editor-Version"], "Editor-Version should be present in model headers");
		assert.ok(headers["Editor-Version"].startsWith("vscode/"), "Editor-Version should be a vscode version");

		// Verify auth headers also contain Editor-Version
		const authHeaders = capturedOptions.headers as Record<string, string> | undefined;
		assert.ok(authHeaders, "auth headers should be defined");
		assert.ok(authHeaders["Editor-Version"], "Editor-Version should be present in auth headers");

		// The prepass must tag itself as a skill-pruner request so the host-side
		// provider gate grants it queue priority over main-session calls when
		// the pruner provider is saturated.
		assert.equal(authHeaders?.["x-pi-request-class"], "skill-pruner", "prepass should set x-pi-request-class: skill-pruner");
	} finally {
		__setCompleteFn(null);
	}
});

test("disabled-by-toggle records keep-all for subagent inheritance without throwing", async () => {
	const prevToggles = process.env.PIE_EXTENSION_TOGGLES_JSON;
	process.env.PIE_EXTENSION_TOGGLES_JSON = JSON.stringify({ "skill-pruner": false });
	try {
		const { handlers } = register(config());
		// Must not throw (regression: sessionId was referenced before declaration).
		const result = await runBeforeAgentStart(handlers, "anything", realisticSkills);
		assert.equal(result, undefined);
		// The disabled path records keep-all keyed by the session id, so subagents
		// spawned this turn inherit "no filter" rather than a stale prior set.
		assert.equal(readKeptSkills("session-1"), "keep-all");
	} finally {
		clearKeptSkills("session-1");
		if (prevToggles === undefined) delete process.env.PIE_EXTENSION_TOGGLES_JSON;
		else process.env.PIE_EXTENSION_TOGGLES_JSON = prevToggles;
	}
});

test("too-short prompt records keep-all for subagent inheritance", async () => {
	try {
		const { handlers } = register(config());
		await runBeforeAgentStart(handlers, "hi", realisticSkills);
		assert.equal(readKeptSkills("session-1"), "keep-all");
	} finally {
		clearKeptSkills("session-1");
	}
});

test("LLM pruning records the kept subset for subagent inheritance", async () => {
	__setCompleteFn(mockCompleteFn({ pruneSkills: ["duckdb-query-optimization", "frontend-design"] }));
	try {
		const { handlers } = register(config());
		await runBeforeAgentStart(handlers, "Refactor this code for clarity", realisticSkills);
		// code-simplification is the only kept skill (the other two are pruned).
		assert.deepEqual(readKeptSkills("session-1"), ["code-simplification"]);
	} finally {
		clearKeptSkills("session-1");
		__setCompleteFn(null);
	}
});

test("context handler filters pruning-result custom messages before provider calls", async () => {
	const { handlers } = register(config());
	const contextHandler = handlers.get("context");
	assert.ok(contextHandler, "context handler registered");

	const messages = [
		{ role: "user", content: "hello" },
		{ role: "custom", customType: "pruning-result", content: "Kept 1/3 skills" },
		{ role: "assistant", content: "ok" },
		{ role: "custom", customType: "other", content: "keep me" },
		{ role: "custom", customType: "pruning-result", content: "cached" },
	];

	const result = await contextHandler({ type: "context", messages }, { cwd: "/repo" }) as { messages: Array<{ role: string; customType?: string }> } | undefined;
	assert.ok(result && Array.isArray(result.messages), "handler returns filtered messages");
	assert.equal(result.messages.length, 3);
	assert.ok(result.messages.some((m) => m.role === "user"));
	assert.ok(result.messages.some((m) => m.role === "assistant"));
	assert.ok(result.messages.some((m) => m.role === "custom" && m.customType === "other"));
	assert.ok(!result.messages.some((m) => m.role === "custom" && m.customType === "pruning-result"));
});
