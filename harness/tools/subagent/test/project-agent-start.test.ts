import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { subagentRuntime } from "../runner.js";
import { discoverSubagentAgents, execute } from "../execute.js";

test("explicit task cwd agents win over same-named session agents with fallbacks preserved", async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "subagent-project-precedence-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempDir;
	try {
		const sessionCwd = path.join(tempDir, "project-a");
		const taskCwd = path.join(tempDir, "project-b");
		const globalDir = path.join(tempDir, "harness", "agent-instructions", "agents");
		for (const dir of [path.join(sessionCwd, "agents"), path.join(taskCwd, "agents"), globalDir]) {
			await mkdir(dir, { recursive: true });
		}
		const definition = (name: string, prompt: string) => `---\nname: ${name}\ndescription: test agent\n---\n${prompt}`;
		await writeFile(path.join(sessionCwd, "agents", "worker.md"), definition("worker", "Project A"));
		await writeFile(path.join(taskCwd, "agents", "worker.md"), definition("worker", "Project B"));
		await writeFile(path.join(globalDir, "worker.md"), definition("worker", "Global"));
		await writeFile(path.join(globalDir, "global-only.md"), definition("global-only", "Global fallback"));
		await writeFile(path.join(sessionCwd, "agents", "session-only.md"), definition("session-only", "Session fallback"));

		const explicit = discoverSubagentAgents(sessionCwd, taskCwd);
		const worker = explicit.agents.find((agent) => agent.name === "worker")!;
		assert.equal(worker.filePath, path.join(taskCwd, "agents", "worker.md"));
		assert.equal(worker.systemPrompt, "Project B");
		assert.equal(explicit.projectAgentsDir, path.join(taskCwd, "agents"));
		assert.equal(explicit.agents.find((agent) => agent.name === "session-only")?.source, "project");
		assert.equal(explicit.agents.find((agent) => agent.name === "global-only")?.source, "user");

		const defaultDiscovery = discoverSubagentAgents(sessionCwd);
		assert.equal(defaultDiscovery.agents.find((agent) => agent.name === "worker")?.systemPrompt, "Project A");
		assert.equal(defaultDiscovery.projectAgentsDir, path.join(sessionCwd, "agents"));
		const missingProject = discoverSubagentAgents(sessionCwd, path.join(tempDir, "no-project"));
		assert.equal(missingProject.agents.find((agent) => agent.name === "worker")?.systemPrompt, "Project A");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("project-local agents reach normal dispatch policy without a startup confirmation", async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "subagent-project-start-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempDir;
	try {
		const agentsDir = path.join(tempDir, "agents");
		await mkdir(agentsDir);
		await writeFile(path.join(agentsDir, "worker.md"), [
			"---",
			"name: worker",
			"description: project test agent",
			"---",
			"Do the delegated task.",
		].join("\n"));

		let confirmationCalls = 0;
		const response = await subagentRuntime.run(
			{ depth: 1, trail: ["parent"], canSpawn: [] },
			() => execute(
				"tool-project-start",
				{ agent: "worker", task: "do work" },
				new AbortController().signal,
				() => undefined,
				{
					cwd: tempDir,
					hasUI: true,
					ui: {
						confirm: async () => {
							confirmationCalls++;
							return false;
						},
					},
				} as any,
				{} as any,
				() => false,
			),
		);

		assert.equal(confirmationCalls, 0, "routine agent startup must not open a permission dialog");
		assert.equal(response.isError, true);
		assert.match(response.content[0].text, /canSpawn allowlist/i);
		assert.equal(response.details.projectAgentsDir, agentsDir);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(tempDir, { recursive: true, force: true });
	}
});
