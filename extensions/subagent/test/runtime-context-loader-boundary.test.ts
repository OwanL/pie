import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const jitiUrl = pathToFileURL(fileURLToPath(
	new URL("../../../extension/node_modules/jiti/lib/jiti-static.mjs", import.meta.url),
)).href;
const runnerPath = fileURLToPath(new URL("../runner.ts", import.meta.url));

test("nested AgentSession loaders inherit the root tree runtime context", () => {
	// Run the real cache-disabled jiti boundary in a child process. Keeping that
	// duplicate module load outside the coverage process prevents its source map
	// from replacing runner.ts's ordinary unit-coverage record.
	const script = `
		import assert from "node:assert/strict";
		import { createJiti } from ${JSON.stringify(jitiUrl)};

		const parentRunner = await createJiti(import.meta.url, { moduleCache: false })
			.import(${JSON.stringify(runnerPath)});
		const nestedRunner = await createJiti(import.meta.url, { moduleCache: false })
			.import(${JSON.stringify(runnerPath)});
		const rootPolicy = { "openai-codex": true, umans: false };
		const rootContext = {
			depth: 1,
			trail: ["scout"],
			subagentProviderToggles: rootPolicy,
		};

		await parentRunner.subagentRuntime.run(rootContext, async () => {
			const inherited = nestedRunner.readRuntimeContext();
			assert.equal(inherited, rootContext);
			assert.equal(inherited.depth, 1);
			assert.deepEqual(inherited.subagentProviderToggles, rootPolicy);
		});
	`;
	const { NODE_V8_COVERAGE: _coverageDir, ...env } = process.env;
	const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
		encoding: "utf8",
		env,
		timeout: 15_000,
	});

	assert.equal(result.status, 0, result.stderr || result.stdout);
});
