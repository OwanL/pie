/**
 * Guard-rail tests for the subagent tool's entry point (src/execute.ts).
 *
 * The orchestration logic (single/parallel/chain execution, session limits,
 * trail-loop prevention, {previous} threading, mode routing, details shape) is
 * already covered end-to-end against the REAL `execute*Mode` functions in
 * modes.test.ts (with a fake SDK). What is NOT covered there — and is unique
 * to `execute()` / `validateSubagentParams()` — is the front-door validation:
 * exactly-one-mode enforcement, unknown-agent detection (with suggestions and
 * the scope-keyword guard), the disabled short-circuit, and the
 * subagent-depth limit. Those guard-rails are exercised here against the REAL
 * exported functions, with no SDK and no LLM, so every case is sub-ms.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execute, validateSubagentParams } from "../src/execute.js";
import { subagentRuntime } from "../runner.js";
import { MAX_DEPTH } from "../src/helpers.js";
import type { AgentConfig } from "../agents.js";

const ENV_KEYS = ["PIE_SUBAGENT_MAX_DEPTH", "PIE_SUBAGENT_MAX_TREE_SESSIONS"] as const;
const envSnapshot: Record<string, string | undefined> = {};

test.before(() => {
	for (const key of ENV_KEYS) envSnapshot[key] = process.env[key];
	// Clear env so these guard-rail tests exercise the compiled-in defaults, not
	// any value inherited from the shell / previous test run.
	for (const key of ENV_KEYS) delete process.env[key];
});

test.after(() => {
	for (const key of ENV_KEYS) {
		if (envSnapshot[key] === undefined) delete process.env[key];
		else process.env[key] = envSnapshot[key];
	}
});

// --- Mock agents (validation only inspects names; no SDK / filesystem) ---

const MOCK_AGENTS: AgentConfig[] = [
	{ name: "worker", description: "General worker", systemPrompt: "", source: "user", filePath: "/fake/worker.md" },
	{ name: "reviewer", description: "Reviewer", systemPrompt: "", source: "user", filePath: "/fake/reviewer.md" },
	{ name: "scout", description: "Scout", systemPrompt: "", source: "project", filePath: "/fake/scout.md" },
];

// Minimal fakes for execute(): the disabled and depth-limit guard-rails return
// before touching ctx, so a near-empty ctx is sufficient.
const noSignal = () => new AbortController().signal;
const noOpUpdate = () => {};
const stubCtx = () => ({}) as any;
const stubPi = () => ({}) as any;

// ============================================================
// validateSubagentParams — exactly-one-mode + agent existence
// ============================================================

test("validateSubagentParams: no mode specified returns ok:false", () => {
	const v = validateSubagentParams({} as any, MOCK_AGENTS);
	assert.equal(v.ok, false);
	assert.equal(v.invalidResults.length, 1);
	assert.match(v.invalidResults[0].stderr, /Invalid parameters\. Provide exactly one mode/);
});

test("validateSubagentParams: multiple modes specified returns ok:false", () => {
	const v = validateSubagentParams(
		{ agent: "worker", task: "do work", tasks: [{ agent: "reviewer", task: "r" }] } as any,
		MOCK_AGENTS,
	);
	assert.equal(v.ok, false);
	assert.match(v.invalidResults[0].stderr, /Provide exactly one mode/);
});

test("validateSubagentParams: valid single mode returns ok:true, mode 'single', no invalid results", () => {
	const v = validateSubagentParams({ agent: "worker", task: "do work" } as any, MOCK_AGENTS);
	assert.equal(v.ok, true);
	if (!v.ok) return;
	assert.equal(v.mode, "single");
	assert.equal(v.invalidResults.length, 0);
});

test("validateSubagentParams: valid parallel mode returns mode 'parallel'", () => {
	const v = validateSubagentParams({ tasks: [{ agent: "worker", task: "t" }] } as any, MOCK_AGENTS);
	assert.equal(v.ok, true);
	if (!v.ok) return;
	assert.equal(v.mode, "parallel");
	assert.equal(v.invalidResults.length, 0);
});

test("validateSubagentParams: valid chain mode returns mode 'chain'", () => {
	const v = validateSubagentParams({ chain: [{ agent: "worker", task: "t" }] } as any, MOCK_AGENTS);
	assert.equal(v.ok, true);
	if (!v.ok) return;
	assert.equal(v.mode, "chain");
	assert.equal(v.invalidResults.length, 0);
});

test("validateSubagentParams: unknown single agent yields a 'Did you mean' suggestion", () => {
	const v = validateSubagentParams({ agent: "Worker", task: "do work" } as any, MOCK_AGENTS);
	assert.equal(v.ok, true);
	if (!v.ok) return;
	assert.equal(v.invalidResults.length, 1);
	assert.equal(v.invalidResults[0].agent, "Worker");
	assert.match(v.invalidResults[0].stderr, /Did you mean "worker"/);
});

test("validateSubagentParams: unknown agent in tasks is reported", () => {
	const v = validateSubagentParams({ tasks: [{ agent: "nonexistent", task: "t" }] } as any, MOCK_AGENTS);
	assert.equal(v.ok, true);
	if (!v.ok) return;
	assert.equal(v.invalidResults.length, 1);
	assert.match(v.invalidResults[0].stderr, /Unknown agent.*nonexistent/);
});

test("validateSubagentParams: unknown agent in chain carries the 1-based step", () => {
	const v = validateSubagentParams({ chain: [{ agent: "worker", task: "ok" }, { agent: "ghost", task: "bad" }] } as any, MOCK_AGENTS);
	assert.equal(v.ok, true);
	if (!v.ok) return;
	assert.equal(v.invalidResults.length, 1);
	assert.equal(v.invalidResults[0].step, 2);
	assert.match(v.invalidResults[0].stderr, /Unknown agent.*ghost/);
});

test("validateSubagentParams: scope keyword used as an agent name triggers the scope-keyword error", () => {
	const v = validateSubagentParams({ agent: "both", task: "do work" } as any, MOCK_AGENTS);
	assert.equal(v.ok, true);
	if (!v.ok) return;
	assert.equal(v.invalidResults.length, 1);
	assert.match(v.invalidResults[0].stderr, /not an available agent name/);
});

// ============================================================
// execute() — disabled short-circuit
// ============================================================

test("execute: isDisabled() short-circuits with the disabled error before touching ctx", async () => {
	const res: any = await execute(
		"tc1",
		{ agent: "worker", task: "do work" } as any,
		noSignal(),
		noOpUpdate,
		stubCtx(),
		stubPi(),
		() => true,
	);
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /Sub agents are disabled/);
	assert.match(res.content[0].text, /--no-subagent/);
	assert.match(res.content[0].text, /PI_SUBAGENT_DISABLED/);
	assert.equal(res.details.results.length, 0);
});

test("execute: the disabled check takes priority over the depth limit", async () => {
	// depth == MAX_DEPTH would normally trip the depth guard, but isDisabled is
	// checked first, so the disabled message wins.
	const res: any = await subagentRuntime.run({ depth: MAX_DEPTH, trail: [] }, () =>
		execute("tc1", { agent: "worker", task: "do work" } as any, noSignal(), noOpUpdate, stubCtx(), stubPi(), () => true),
	);
	assert.match(res.content[0].text, /Sub agents are disabled/);
	assert.doesNotMatch(res.content[0].text, /depth limit/);
});

// ============================================================
// execute() — subagent depth limit
// ============================================================

test("execute: depth >= MAX_DEPTH short-circuits with the depth-limit error", async () => {
	const res: any = await subagentRuntime.run({ depth: MAX_DEPTH, trail: [] }, () =>
		execute("tc1", { agent: "worker", task: "do work" } as any, noSignal(), noOpUpdate, stubCtx(), stubPi(), () => false),
	);
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /Subagent depth limit reached/);
	assert.match(res.content[0].text, new RegExp(`max ${MAX_DEPTH}`));
	assert.equal(res.details.results.length, 0);
});

test("execute: depth just below MAX_DEPTH passes the depth guard (reaches validation)", async (t) => {
	// depth = MAX_DEPTH - 1 must NOT trip the guard. Execution proceeds to
	// discoverAgents + validateSubagentParams; with an unknown agent and no
	// project agents/ dir, validation throws on the unknown agent — proving we
	// got past the depth check (an off-by-one like `>` instead of `>=` would
	// wrongly return the depth-limit message here).
	const tmpDir = mkdtempSync(path.join(os.tmpdir(), "subagent-depth-allow-"));
	t.after(() => { rmSync(tmpDir, { recursive: true, force: true }); });
	await assert.rejects(
		subagentRuntime.run({ depth: MAX_DEPTH - 1, trail: [] }, () =>
			execute(
				"tc1",
				{ agent: "definitely-not-an-agent", task: "do work" } as any,
				noSignal(),
				noOpUpdate,
				{ cwd: tmpDir } as any,
				stubPi(),
				() => false,
			),
		),
		/Unknown agent.*definitely-not-an-agent/,
	);
});
