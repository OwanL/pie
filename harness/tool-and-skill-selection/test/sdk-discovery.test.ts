/**
 * Pinned-SDK discovery regression for the skill-pruner root shim.
 *
 * The SDK load runs in a spawned worker (sdk-discovery-worker.ts): the real
 * SDK's loader evaluates the repo's TS modules through its own ESM import
 * chain, and mixing those instances with the CJS `require()` instances held by
 * the other tests of this package corrupts node's coverage merge (it DROPPED
 * real coverage, e.g. prepass.ts 88.9% -> 58.2%). A separate process keeps one
 * module-instance set per process, so this regression still runs in every
 * suite without poisoning the package's honest coverage aggregate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const worker = path.join(repoRoot, "harness", "tool-and-skill-selection", "test", "sdk-discovery-worker.ts");

test("pinned SDK discovery loads the root shim with one shared selector and recovery state", () => {
	const result = spawnSync(process.execPath, [tsxCli, worker], {
		cwd: repoRoot,
		encoding: "utf-8",
		timeout: 120_000,
		// The worker must not report coverage: its ESM instances of the repo graph
		// would merge into the test process's report and corrupt it (see the
		// header comment in sdk-discovery-worker.ts).
		env: { ...process.env, NODE_V8_COVERAGE: undefined },
	});
	assert.equal(result.status, 0, `SDK discovery worker failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout ?? "", /SDK_DISCOVERY_OK/u);
});