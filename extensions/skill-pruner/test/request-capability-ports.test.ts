import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Module, { createRequire } from "node:module";
import type { Skill, ToolInfo } from "@earendil-works/pi-coding-agent";
import { setLogPathForTesting, flushLog } from "../logger.js";
import {
	createRequestCapabilityTool,
	type RequestCapabilityPorts,
	type SkillRecord,
} from "../../../tools/request-capability/index.js";

// skill-pruner's state module imports the SDK's formatSkillsForPrompt as a
// value, which cannot resolve outside the bundled runtime. Install the same
// minimal mock-SDK resolver integration.test.ts uses; these focused tests
// never call the formatter. The extracted tool imports the SDK type-only, so
// the mock is only needed for the owner-state import.
function installSdkResolverForTests(): void {
	const mockDir = mkdtempSync(path.join(tmpdir(), "request-capability-sdk-mock-"));
	const sdkPath = path.join(mockDir, "pi-coding-agent.cjs");
	writeFileSync(sdkPath, "exports.formatSkillsForPrompt = () => { throw new Error('test must not format skills'); };\n", "utf-8");
	const moduleWithResolver = Module as typeof Module & {
		_resolveFilename: (request: string, parent?: unknown, isMain?: boolean, options?: unknown) => string;
	};
	const originalResolveFilename = moduleWithResolver._resolveFilename;
	moduleWithResolver._resolveFilename = function resolveFilename(request, parent, isMain, options): string {
		if (request === "@earendil-works/pi-coding-agent") {
			return sdkPath;
		}
		return originalResolveFilename.call(this, request, parent, isMain, options);
	};
}

installSdkResolverForTests();
const require = createRequire(import.meta.url);
const {
	clearCapabilityStateForTesting,
	clearPrunedToolsForTesting,
	getHiddenSkills,
	getLoadedSkills,
	getPrunedTools,
	recordHiddenSkills,
	recordPrunedTools,
} = require("../src/state.js") as typeof import("../src/state.js");
const { createRequestCapabilityDefinition } = require("../src/tools.js") as typeof import("../src/tools.js");

const TOOL_INFO = [
	{ name: "read", description: "read files" },
	{ name: "edit", description: "edit files" },
	{ name: "web_search", description: "web search" },
] as unknown as ToolInfo[];

function skillFixture(name: string, dir: string, body = `# ${name} procedure\n\nFollow this exactly.\n`): Skill {
	const filePath = path.join(dir, `${name}.SKILL.md`);
	writeFileSync(filePath, `---\nname: ${name}\ndescription: hidden\n---\n\n${body}\n`, "utf-8");
	return {
		name,
		description: "hidden",
		filePath,
		baseDir: dir,
		sourceInfo: {} as Skill["sourceInfo"],
		disableModelInvocation: false,
	} as unknown as Skill;
}

interface FakeState {
	pruned: Set<string>;
	hiddenSkills: Map<string, SkillRecord>;
	loadedSkills: Set<string>;
	activeTools: string[];
	activationLog: string[][];
	skillRecoveries: string[];
	toolRecoveries: string[];
}

function makeFakePorts(initial: {
	allTools?: ToolInfo[];
	activeTools?: string[];
	pruned?: string[];
	hiddenSkills?: SkillRecord[];
	dependencies?: Record<string, string[]>;
	autonomousMode?: boolean;
} = {}) {
	const state: FakeState = {
		pruned: new Set(initial.pruned ?? []),
		hiddenSkills: new Map((initial.hiddenSkills ?? []).map((skill) => [skill.name, skill])),
		loadedSkills: new Set<string>(),
		activeTools: [...(initial.activeTools ?? [])],
		activationLog: [],
		skillRecoveries: [],
		toolRecoveries: [],
	};
	const ports: RequestCapabilityPorts = {
		getAllTools: () => initial.allTools ?? [],
		getActiveTools: () => [...state.activeTools],
		setActiveTools: (names) => {
			state.activeTools = [...names];
			state.activationLog.push(names);
		},
		getSessionId: () => "fake-session",
		getPrunedTools: () => state.pruned,
		getHiddenSkills: () => state.hiddenSkills,
		getLoadedSkills: () => state.loadedSkills,
		recordLoadedSkill: (_sessionId, skillName) => {
			state.loadedSkills.add(skillName);
		},
		isAutonomousModeEnabled: () => initial.autonomousMode ?? false,
		askUserToolName: "ask_user",
		getToolDependencies: () => initial.dependencies ?? {},
		recordSkillRecovery: (_sessionId, skillName) => {
			state.skillRecoveries.push(skillName);
		},
		recordToolRecovery: (_sessionId, toolName) => {
			state.toolRecoveries.push(toolName);
		},
	};
	return { ports, state };
}

type AnyExecute = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: unknown,
) => Promise<any>;

/** Call a definition's execute with the test runner's loose arguments,
 *  mirroring how the existing integration suite drives tools through a
 *  widened execute type. */
const callTool = (
	tool: { execute: unknown },
	toolCallId: string,
	params: Record<string, unknown> = {},
	ctx: unknown = {},
) => (tool as { execute: AnyExecute }).execute(toolCallId, params, undefined, undefined, ctx);

test("extracted tool runs entirely through injected ports without touching skill-pruner state", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "request-capability-ports-"));
	const skill = skillFixture("cap-skill", dir);
	recordPrunedTools("real-session-noise", ["read"]); // real-state noise the tool must never consult
	const { ports, state } = makeFakePorts({
		allTools: TOOL_INFO,
		activeTools: ["read"],
		pruned: ["edit", "web_search"],
		hiddenSkills: [{ name: skill.name, filePath: skill.filePath, baseDir: skill.baseDir }],
	});
	try {
		const tool = createRequestCapabilityTool(ports);
		const listed = await callTool(tool, "list") as any;
		assert.equal(listed.content[0].text, "tools\tedit, web_search\nskills\tcap-skill");

		const enabled = await callTool(tool, "enable", { capabilityType: "tool", capabilityName: "edit" }) as any;
		assert.match(enabled.content[0].text, /Enabled tool 'edit'/);
		assert.ok(state.activeTools.includes("edit"));
		assert.deepEqual(state.toolRecoveries, ["edit"]);

		const loaded = await callTool(tool, "load", { capabilityType: "skill", capabilityName: "cap-skill" }) as any;
		assert.match(loaded.content[0].text, /<skill name="cap-skill"/);
		assert.ok(state.loadedSkills.has("cap-skill"));
		assert.deepEqual(state.skillRecoveries, ["cap-skill"]);

		// The injected lifecycle state is the tool's only store: skill-pruner's
		// real owner state was neither consulted (the pruned "read" noise under
		// a different session is invisible) nor mutated.
		assert.equal(getPrunedTools("fake-session").size, 0);
		assert.equal(getHiddenSkills("fake-session").size, 0);
		assert.equal(getLoadedSkills("fake-session").size, 0);
		// The noise session's owner state is unchanged by the tool call.
		assert.deepEqual([...getPrunedTools("real-session-noise")], ["read"]);
	} finally {
		clearCapabilityStateForTesting();
		clearPrunedToolsForTesting();
	}
});

test("adapter wires the extracted tool to skill-pruner's single lifecycle state", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "request-capability-adapter-"));
	const logPath = path.join(dir, "pruning.jsonl");
	setLogPathForTesting(logPath);
	let activated: string[] = [];
	try {
		const definition = createRequestCapabilityDefinition({
			getAllTools: () => TOOL_INFO,
			getActiveTools: () => ["read"],
			setActiveTools: (names) => {
				activated = names;
			},
		});
		// State recorded by the owner module AFTER construction is visible to
		// the tool: it reads through the ports on every call, no copied snapshot.
		recordPrunedTools("session-shared", ["web_search"]);
		const listed = await callTool(definition, "list", {},
			{ sessionManager: { getSessionId: () => "session-shared" } }) as any;
		assert.equal(listed.content[0].text, "tools\tweb_search\nskills\t(none)");

		// Recovery telemetry flows through the skill-pruner logger port.
		const enabled = await callTool(definition, "enable",
			{ capabilityType: "tool", capabilityName: "web_search" },
			{ sessionManager: { getSessionId: () => "session-shared" } }) as any;
		assert.match(enabled.content[0].text, /Enabled tool 'web_search'/);
		assert.ok(activated.includes("web_search"));
		await flushLog();
		const lines = readFileSync(logPath, "utf-8").trim().split("\n")
			.map((line) => JSON.parse(line) as { event?: string; toolName?: string });
		assert.ok(lines.some((line) => line.event === "tool_recovered" && line.toolName === "web_search"));
	} finally {
		setLogPathForTesting(null);
		clearCapabilityStateForTesting();
		clearPrunedToolsForTesting();
	}
});

test("recovered skill state is recorded into skill-pruner's owner state, not a tool-local duplicate", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "request-capability-loaded-"));
	const skill = skillFixture("loaded-skill", dir);
	const definition = createRequestCapabilityDefinition({
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => {},
	});
	try {
		recordHiddenSkills("session-load", [skill]);
		const result = await callTool(definition, "load",
			{ capabilityType: "skill", capabilityName: "loaded-skill" },
			{ sessionManager: { getSessionId: () => "session-load" } }) as any;
		assert.match(result.content[0].text, /<skill name="loaded-skill"/);
		// Written through the injected port into skill-pruner's state module.
		assert.ok(getLoadedSkills("session-load").has("loaded-skill"));

		// A second definition constructed from the same owner state observes the
		// write: the recovered skill is no longer hidden for it.
		const second = createRequestCapabilityDefinition({
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools: () => {},
		});
		const listed = await callTool(second, "list-2", {},
			{ sessionManager: { getSessionId: () => "session-load" } }) as any;
		assert.equal(listed.content[0].text, "No capabilities are hidden by the latest pruning decision.");
	} finally {
		clearCapabilityStateForTesting();
	}
});

test("extracted tool preserves the schema, descriptions, and guidance exactly", () => {
	const extracted = createRequestCapabilityTool(makeFakePorts().ports);
	const adapter = createRequestCapabilityDefinition({
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => {},
	});
	assert.equal(extracted.name, adapter.name);
	assert.equal(extracted.label, adapter.label);
	assert.equal(extracted.description, adapter.description);
	assert.equal(extracted.promptSnippet, adapter.promptSnippet);
	assert.deepEqual(extracted.promptGuidelines, adapter.promptGuidelines);
	assert.deepEqual(extracted.parameters, adapter.parameters);
});

test("injected policy ports govern autonomous-mode withholding and dependency re-enable", async () => {
	// Policy port: with autonomous mode on, ask_user stays withheld.
	const autonomous = makeFakePorts({
		allTools: [...TOOL_INFO, { name: "ask_user", description: "Ask the user" } as unknown as ToolInfo],
		activeTools: ["read"],
		pruned: ["ask_user"],
		autonomousMode: true,
	});
	const autonomousTool = createRequestCapabilityTool(autonomous.ports);
	const listed = await callTool(autonomousTool, "list") as any;
	assert.equal(listed.content[0].text, "No capabilities are hidden by the latest pruning decision.");
	const recovered = await callTool(autonomousTool, "recover",
		{ capabilityType: "tool", capabilityName: "ask_user" }) as any;
	assert.equal(recovered.isError, true);
	assert.match(recovered.content[0].text, /unavailable while autonomous mode/);
	assert.equal(autonomous.state.activationLog.length, 0);

	// Policy port: the injected dependency map drives transitive re-enable.
	const dependencies = makeFakePorts({
		allTools: TOOL_INFO,
		activeTools: ["read"],
		pruned: ["edit"],
		dependencies: { edit: ["read"] },
	});
	const dependencyTool = createRequestCapabilityTool(dependencies.ports);
	const result = await callTool(dependencyTool, "call",
		{ capabilityType: "tool", capabilityName: "edit" }) as any;
	assert.match(result.content[0].text, /Enabled tool 'edit'/);
	assert.ok(dependencies.state.activeTools.includes("edit"));
	assert.ok(dependencies.state.activeTools.includes("read"));
});