import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { test } from "node:test";
import { SUBAGENT_GUIDANCE } from "../guidance.js";
import { formatSubagentPrompt } from "../user-context.js";
import { TRAVERSAL_POLICY_PROMPT } from "../../execution-safety/traversal-policy.js";

test("static subagent guidance preserves exact metadata", () => {
	assert.equal(SUBAGENT_GUIDANCE.description, "Delegate one concrete task to a specialized agent with isolated context; isolation is not sandboxing — the child shares the parent's process, filesystem, and credentials. Agents are discovered automatically from both user and project directories, including project agents under an explicitly provided cwd.");
	assert.equal(SUBAGENT_GUIDANCE.disabledDescription, "DISABLED: Sub agents are currently disabled. Calls to this tool will return an error immediately. Enable by removing the --no-subagent flag or unsetting the PI_SUBAGENT_DISABLED environment variable.");
	assert.equal(SUBAGENT_GUIDANCE.snippet, "Delegate one small, bounded task to a discovered agent; prefer parallel sibling calls for independent tasks.");
	assert.equal(SUBAGENT_GUIDANCE.disabledSnippet, "DISABLED: Sub agents are disabled.");
	assert.equal(SUBAGENT_GUIDANCE.guideline, "Proactively dispatch independent, small subagent tasks together as sibling calls in one response. Give parallel workers non-overlapping edit ownership; wait for prior results when tasks depend on them, and serialize work that would conflict over shared files or resources.");
});

test("bundled guidance falls back to PI_CODING_AGENT_DIR and stays cached after markdown changes", async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "subagent-guidance-fallback-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const modulePath = path.join(tempDir, "bundle", "harness", "tools", "subagent", "guidance.mjs");
	const guidancePath = path.join(tempDir, "config", "harness", "agent-instructions", "subagent-guidance.md");
	const initialMarkdown = [
		"## description\nInitial description",
		"## disabled-description\nInitial disabled description",
		"## snippet\nInitial snippet",
		"## disabled-snippet\nInitial disabled snippet",
		"## guideline\nInitial guideline",
		"## parent-context\nInitial parent context",
	].join("\n\n");

	try {
		await mkdir(path.dirname(modulePath), { recursive: true });
		await mkdir(path.dirname(guidancePath), { recursive: true });
		await writeFile(guidancePath, initialMarkdown, "utf8");
		const source = await readFile(new URL("../guidance.ts", import.meta.url), "utf8");
		const transpiled = ts.transpileModule(source, {
			compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
		}).outputText;
		await writeFile(modulePath, transpiled, "utf8");

		// In this bundled-style location, the source-relative candidate resolves
		// under bundle/harness and is absent; only the configured root can load it.
		const sourceRelativePath = path.resolve(path.dirname(modulePath), "../../..", "harness/agent-instructions/subagent-guidance.md");
		await assert.rejects(readFile(sourceRelativePath), { code: "ENOENT" });
		process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "config");

		const moduleUrl = pathToFileURL(modulePath).href;
		const loaded = await import(moduleUrl) as typeof import("../guidance.js");
		assert.equal(loaded.SUBAGENT_GUIDANCE.description, "Initial description");
		assert.equal(loaded.SUBAGENT_GUIDANCE.parentContext, "Initial parent context");

		await writeFile(guidancePath, initialMarkdown.replaceAll("Initial", "Modified"), "utf8");
		const reloaded = await import(moduleUrl) as typeof import("../guidance.js");
		assert.strictEqual(reloaded.SUBAGENT_GUIDANCE, loaded.SUBAGENT_GUIDANCE);
		assert.equal(reloaded.SUBAGENT_GUIDANCE.description, "Initial description");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("direct user-context consumer preserves exact context placement", () => {
	const base = `${TRAVERSAL_POLICY_PROMPT}\n\nTask: task\n`;
	assert.equal(formatSubagentPrompt("task\n"), base);
	assert.equal(formatSubagentPrompt("task\n", "quoted\ntext"), `${base}\n\nParent user context is quoted below as supporting requirements. Later recorded clarifications override earlier prompts. Keep the delegated task as your scope; if it conflicts with this context, report the conflict instead of silently choosing one.\n\n<parent_user_context>\nquoted\ntext\n</parent_user_context>`);
	assert.ok(Object.isFrozen(SUBAGENT_GUIDANCE));
});
