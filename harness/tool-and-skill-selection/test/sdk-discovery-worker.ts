/**
 * Standalone worker for the verified-source SDK discovery regression
 * (driven by sdk-discovery.test.ts, which spawns this script).
 *
 * The real SDK's extension loader evaluates the repo's TS modules through its
 * own ESM import chain. If that happened inside the test-runner child that
 * also holds the CJS `require()` instances of the same files, node's coverage
 * reporter merged the two transform instances into one misleading per-file
 * report and DROPPED real coverage for code the other tests demonstrably
 * execute (prepass.ts: 88.9% -> 58.2%). Running the SDK load in its own
 * process keeps the skill-pruner package's coverage aggregate honest while
 * this regression still runs in every suite.
 *
 * Exit 0 + `SDK_DISCOVERY_OK` on stdout means every assertion below passed.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentToolResult, Skill, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { SourceArtifactSdkModule, SourceSdkLoadMode } from "../../agent-processes/lib/sdk-integration/sdk.js";
import { verifySdkRuntimeArtifactDescriptor } from "../../agent-processes/lib/sdk-integration/sdk-runtime-artifact.js";

const SOURCE_MODE_ENV = "PIE_SKILL_PRUNER_SDK_DISCOVERY_SOURCE_MODE";

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

/** The hook result is typed only as the loader's erased handler return, so
 *  narrow the systemPrompt structurally at runtime before asserting on it. */
function isHookSystemPromptResult(value: unknown): value is { systemPrompt: string } {
	return typeof value === "object" && value !== null
		&& "systemPrompt" in value
		&& typeof value.systemPrompt === "string"
		&& value.systemPrompt.length > 0;
}

/** AgentToolResult is returned by the real ToolDefinition.execute contract;
 *  take the leading text block through the union discriminant, with an assert
 *  fallback instead of a cast. */
function firstToolResultText(result: AgentToolResult<unknown>): string {
	const first = result.content[0];
	if (first?.type === "text") return first.text;
	return assert.fail("tool result must start with text content");
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function systemPrompt(skills: Skill[]): string {
	return `Base prompt.${testFormatSkillsForPrompt(skills)}\nCurrent date: 2026-05-16`;
}

async function main(): Promise<void> {
	const sourceModeJson = process.env[SOURCE_MODE_ENV];
	assert.ok(sourceModeJson, "parent test must bind the worker to the shared source SDK runtime mode");
	const sourceMode = JSON.parse(sourceModeJson) as SourceSdkLoadMode;
	assert.equal(sourceMode.mode, "source-artifact", "the child binding must select the verified source artifact runtime");
	if (sourceMode.surface !== "full") throw new Error("SDK discovery requires the full source artifact runtime surface.");
	const backendTarget = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules };
	assert.deepEqual(sourceMode.backendTarget, backendTarget,
		"parent and child must use the same shared source runtime target");

	// Verify the parent-bound descriptor independently before importing the
	// public SDK loader, which in turn re-verifies it immediately before its
	// absolute ESM import of the selected artifact.
	const verifiedDescriptor = await verifySdkRuntimeArtifactDescriptor(sourceMode.descriptor, backendTarget);
	assert.deepEqual(verifiedDescriptor, sourceMode.descriptor,
		"the independently verified descriptor must be the exact child binding");

	const { loadSdk } = await import("../../agent-processes/lib/sdk-integration/sdk.js");
	const sdk: SourceArtifactSdkModule = await loadSdk(verifiedDescriptor.sdkPath, {
		...sourceMode,
		descriptor: verifiedDescriptor,
		backendTarget,
		surface: "full",
	});

	const tempRoot = mkdtempSync(path.join(tmpdir(), "skill-pruner-sdk-discovery-"));
	const configRoot = tempRoot;
	// The repo root is needed only as the caller-owned base for the checked-in
	// extension path. Config, auth, session, cache, and data authorities remain
	// redirected to this worker's disposable fixture directories.
	const agentDir = process.cwd();
	const cwd = path.join(tempRoot, "project");
	const skillsDir = path.join(tempRoot, "test-skills");
	const settingsPath = path.join(configRoot, "settings.json");
	const shimPath = path.resolve(agentDir, "extensions", "skill-pruner", "index.ts");
	const isolatedAgentDir = path.join(tempRoot, "agent");
	const isolatedAuthDir = path.join(tempRoot, "auth");
	const isolatedSessionDir = path.join(tempRoot, "sessions");
	const isolatedDataDir = path.join(tempRoot, "data");
	const originalConfigRoot = process.env.PI_CODING_AGENT_DIR;
	const originalAuthDir = process.env.PI_CODING_AGENT_AUTH_DIR;
	const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
	const originalDataDir = process.env.PIE_DATA_DIR;
	const originalToggles = process.env.PIE_EXTENSION_TOGGLES_JSON;
	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;

	mkdirSync(cwd, { recursive: true });
	mkdirSync(path.join(skillsDir, "hidden-skill"), { recursive: true });
	mkdirSync(path.join(skillsDir, "visible-skill"), { recursive: true });
	mkdirSync(isolatedAgentDir, { recursive: true });
	mkdirSync(isolatedAuthDir, { recursive: true });
	mkdirSync(isolatedSessionDir, { recursive: true });
	mkdirSync(isolatedDataDir, { recursive: true });
	writeFileSync(path.join(skillsDir, "hidden-skill", "SKILL.md"), "---\nname: hidden-skill\ndescription: A hidden skill for the SDK discovery regression.\n---\n\nLoad this skill only when requested.\n", "utf-8");
	writeFileSync(path.join(skillsDir, "visible-skill", "SKILL.md"), "---\nname: visible-skill\ndescription: A visible skill for the SDK discovery regression.\n---\n\nThis skill remains available.\n", "utf-8");
	writeFileSync(settingsPath, JSON.stringify({
		pruning: {
			mode: "auto",
			model: "test-pruner",
			provider: "ollama",
			thinkingLevel: "off",
			skills: { strategy: "discretion", ceiling: 8, pinned: [], alwaysKeep: [] },
			tools: { strategy: "discretion", ceiling: 10, dependencies: {}, alwaysKeep: [] },
			prepass: { maxTransportRetries: 0, transportBackoffBaseMs: 0 },
		},
	}), "utf-8");

	process.env.PI_CODING_AGENT_DIR = configRoot;
	process.env.PI_CODING_AGENT_AUTH_DIR = isolatedAuthDir;
	process.env.PI_CODING_AGENT_SESSION_DIR = isolatedSessionDir;
	process.env.PIE_DATA_DIR = isolatedDataDir;
	delete process.env.PIE_EXTENSION_TOGGLES_JSON;
	const ollamaModel = {
		id: "test-pruner",
		name: "SDK discovery test model",
		provider: "ollama",
		api: "ollama",
		baseUrl: "http://127.0.0.1:11434",
		reasoning: false,
		input: ["text"],
		contextWindow: 8192,
		maxTokens: 256,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		fetchCalls++;
		assert.equal(String(input), "http://127.0.0.1:11434/api/chat");
		return new Response(JSON.stringify({
			message: { content: JSON.stringify({ pruneSkills: ["hidden-skill"], pruneTools: ["web_search"] }) },
			done_reason: "stop",
			prompt_eval_count: 64,
			eval_count: 24,
		}), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;

	try {
		const settingsManager = sdk.SettingsManager.inMemory({
			extensions: ["!**", "+extensions/skill-pruner/index.ts"],
			skills: ["!**"],
		}, { projectTrusted: false });
		const resourceLoader = new sdk.DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalSkillPaths: [skillsDir],
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();

		const loaded = resourceLoader.getExtensions();
		assert.deepEqual(loaded.errors, [], "the real SDK loader should load the root extension shim without errors");
		assert.equal(loaded.extensions.length, 1);
		assert.equal(loaded.extensions[0].resolvedPath, shimPath, "the SDK must discover the checked-in root shim, not a copied test implementation");
		assert.ok(loaded.extensions[0].handlers.get("before_agent_start")?.length);
		assert.ok(loaded.extensions[0].tools.has("request_capability"));

		const skills = resourceLoader.getSkills().skills;
		assert.deepEqual(skills.map((entry: Skill) => entry.name).sort(), ["hidden-skill", "visible-skill"]);
		const allTools = [
			{ name: "read", description: "Read files" },
			{ name: "edit", description: "Edit files" },
			{ name: "web_search", description: "Search the web" },
			{ name: "request_capability", description: "Recover hidden capabilities" },
		] as unknown as ToolInfo[];
		let activeTools = allTools.map((tool) => tool.name);
		const sessionId = "sdk-discovered-skill-pruner";
		// A real in-memory source SessionManager pins the shared session identity for
		// both the before_agent_start hook and the recovery tool, while persist=false
		// keeps it writing nothing outside this worker's disposable fixture dirs.
		const sessionManager = sdk.SessionManager.inMemory(cwd, { id: sessionId });
		assert.equal(sessionManager.getSessionId(), sessionId,
			"the fixture session manager must pin the desired shared session identity");
		const modelRegistry = {
			find: (provider: string, id: string) => provider === "ollama" && id === ollamaModel.id ? ollamaModel : undefined,
		};
		loaded.runtime.getAllTools = () => allTools;
		loaded.runtime.getActiveTools = () => [...activeTools];
		loaded.runtime.setActiveTools = (names: string[]) => { activeTools = [...names]; };

		const event = {
			type: "before_agent_start",
			prompt: "Use the visible skill and tools",
			systemPrompt: systemPrompt(skills),
			systemPromptOptions: { cwd, skills, selectedTools: [...activeTools], contextFiles: [] },
		};
		const hook = loaded.extensions[0].handlers.get("before_agent_start")![0];
		const result = await hook(event, { cwd, sessionManager, modelRegistry });
		assert.equal(fetchCalls, 1, "the discovered root shim performs one local prepass model call");
		if (!isHookSystemPromptResult(result)) {
			assert.fail("the before_agent_start hook must return a non-empty systemPrompt result");
		}
		assert.doesNotMatch(result.systemPrompt, /<name>hidden-skill<\/name>/u);
		assert.match(result.systemPrompt, /<name>visible-skill<\/name>/u);
		assert.ok(!activeTools.includes("web_search"));

		const capability = loaded.extensions[0].tools.get("request_capability")?.definition;
		assert.ok(capability, "request_capability was registered by the discovered shim");
		// The recovery tool is invoked through the real ToolDefinition contract, so
		// it gets a real ExtensionContext from the SDK runner, sharing the same
		// in-memory session manager and its session identity with the hook above.
		const recoveryRunner = new sdk.ExtensionRunner(
			loaded.extensions, loaded.runtime, cwd, sessionManager,
			sdk.ModelRegistry.inMemory(sdk.AuthStorage.inMemory()),
		);
		const toolContext = recoveryRunner.createContext();
		const callCapability = async (params: Record<string, unknown>): Promise<string> =>
			firstToolResultText(await capability.execute(
				"sdk-discovery-test", params, undefined, undefined, toolContext,
			));
		const listed = await callCapability({});
		assert.match(listed, /tools\tweb_search/u);
		assert.match(listed, /skills\thidden-skill/u,
			"the loaded recovery tool sees the exact skill/tool state written by the loaded selector");
		const recovered = await callCapability({ capabilityType: "skill", capabilityName: "hidden-skill" });
		assert.match(recovered, /Load this skill only when requested\./u);
		const listedAfterRecovery = await callCapability({});
		assert.doesNotMatch(listedAfterRecovery, /hidden-skill/u,
			"skill recovery writes back to the same canonical loaded-skill state");
		const recoveryLogPath = path.join(configRoot, "data", "pruning.jsonl");
		let recoveryLogged = false;
		for (let attempt = 0; attempt < 50; attempt++) {
			if (existsSync(recoveryLogPath) && readFileSync(recoveryLogPath, "utf-8").includes('"event":"skill_recovered"')) {
				recoveryLogged = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.ok(recoveryLogged, "the discovered tool completed its queued recovery audit before temp cleanup");
	} finally {
		globalThis.fetch = originalFetch;
		if (originalConfigRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalConfigRoot;
		if (originalAuthDir === undefined) delete process.env.PI_CODING_AGENT_AUTH_DIR;
		else process.env.PI_CODING_AGENT_AUTH_DIR = originalAuthDir;
		if (originalSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
		else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir;
		if (originalDataDir === undefined) delete process.env.PIE_DATA_DIR;
		else process.env.PIE_DATA_DIR = originalDataDir;
		if (originalToggles === undefined) delete process.env.PIE_EXTENSION_TOGGLES_JSON;
		else process.env.PIE_EXTENSION_TOGGLES_JSON = originalToggles;
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

void (async () => {
	try {
		await main();
		console.log("SDK_DISCOVERY_OK");
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	}
})();
