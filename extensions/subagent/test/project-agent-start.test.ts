import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { subagentRuntime } from "../runner.js";
import { execute } from "../src/execute.js";

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
