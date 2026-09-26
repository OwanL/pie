/**
 * Standalone worker for the pinned-SDK discovery regression
 * (driven by sdk-discovery.test.ts, which spawns this script).
 *
 * The real SDK's extension loader evaluates the repo's TS modules through its
 * own ESM import chain. If that happened inside the test-runner child that
 * also holds the CJS `require()` instances of the same files, node's coverage
 * reporter merged the two transform instances into one misleading per-file
 * report and DROPPED real coverage for code the other tests demonstrably
 * execute (prepass.ts: 88.9% -> 58.2%). Running the SDK load in its own
 * process keeps one module-instance set per process, so the skill-pruner
 * package's coverage aggregate stays honest while this regression still runs
 * in every suite.
 *
 * Exit 0 + `SDK_DISCOVERY_OK` on stdout means every assertion below passed.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Skill, ToolInfo } from "@earendil-works/pi-coding-agent";

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
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function systemPrompt(skills: Skill[]): string {
	return `Base prompt.${testFormatSkillsForPrompt(skills)}\nCurrent date: 2026-05-16`;
}

async function main(): Promise<void> {
	const tempRoot = mkdtempSync(path.join(tmpdir(), "skill-pruner-sdk-discovery-"));
	const configRoot = tempRoot;
	const agentDir = process.cwd();
	const cwd = path.join(tempRoot, "project");
	const skillsDir = path.join(tempRoot, "test-skills");
	const settingsPath = path.join(configRoot, "settings.json");
	const shimPath = path.resolve(agentDir, "extensions", "skill-pruner", "index.ts");
	const originalConfigRoot = process.env.PI_CODING_AGENT_DIR;
	const originalToggles = process.env.PIE_EXTENSION_TOGGLES_JSON;
	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;

	mkdirSync(cwd, { recursive: true });
	mkdirSync(path.join(skillsDir, "hidden-skill"), { recursive: true });
	mkdirSync(path.join(skillsDir, "visible-skill"), { recursive: true });
	writeFileSync(path.join(skillsDir, "hidden-skill", "SKILL.md"), "---\nname: hidden-skill\ndescription: A hidden skill for the SDK discovery regression.\n---\n\nLoad this skill only when requested.\n", "utf-8");
	writeFileSync(path.join(skillsDir, "visible-skill", "SKILL.md"), "---\nname: visible-skill\ndescription: A visible skill for the SDK discovery regression.\n---\n\nThis skill remains available.\n", "utf-8");
	writeFileSync(settingsPath, JSON.stringify({
		pruning: {
			mode: "auto",
			model: "test-pruner",
			provider: "ollama",
			thinkingLevel: "off",
			autoSkipBelowTokens: null,
			skills: { strategy: "discretion", ceiling: 8, pinned: [], alwaysKeep: [] },
			tools: { strategy: "discretion", ceiling: 10, dependencies: {}, alwaysKeep: [] },
			prepass: { maxTransportRetries: 0, transportBackoffBaseMs: 0 },
		},
	}), "utf-8");

	process.env.PI_CODING_AGENT_DIR = configRoot;
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
		const sdkRoot = path.join(process.cwd(), "application", "hosts", "vscode", "node_modules", "@earendil-works", "pi-coding-agent", "dist");
		const sdk = await import(pathToFileURL(path.join(sdkRoot, "index.js")).href) as any;
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
		const sessionManager = { getSessionId: () => sessionId, getSessionFile: () => undefined };
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
		assert.ok(result?.systemPrompt);
		assert.doesNotMatch(result.systemPrompt, /<name>hidden-skill<\/name>/u);
		assert.match(result.systemPrompt, /<name>visible-skill<\/name>/u);
		assert.ok(!activeTools.includes("web_search"));

		const capability = loaded.extensions[0].tools.get("request_capability")?.definition;
		assert.ok(capability, "request_capability was registered by the discovered shim");
		const callCapability = (params: Record<string, unknown>) => capability.execute(
			"sdk-discovery-test", params, undefined, undefined, { sessionManager },
		) as Promise<{ content: Array<{ text: string }> }>;
		const listed = await callCapability({});
		assert.match(listed.content[0].text, /tools\tweb_search/u);
		assert.match(listed.content[0].text, /skills\thidden-skill/u,
			"the loaded recovery tool sees the exact skill/tool state written by the loaded selector");
		const recovered = await callCapability({ capabilityType: "skill", capabilityName: "hidden-skill" });
		assert.match(recovered.content[0].text, /Load this skill only when requested\./u);
		const listedAfterRecovery = await callCapability({});
		assert.doesNotMatch(listedAfterRecovery.content[0].text, /hidden-skill/u,
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