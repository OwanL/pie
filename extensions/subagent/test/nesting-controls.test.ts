/**
 * Tests for the nesting-control machinery introduced to encourage nested
 * subagents: the caller `canSpawn` allowlist, configurable max depth, and the
 * tree-wide session budget.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { subagentRuntime, getMaxDepth, getMaxTreeSessions, consumeTreeSlot, DEFAULT_MAX_DEPTH, DEFAULT_MAX_TREE_SESSIONS } from "../runner.js";
import { disallowedByCanSpawn, execute, resolveTreeSubagentProviderToggles } from "../src/execute.js";
import { MAX_DEPTH } from "../src/helpers.js";
import {
	ALL_SUBAGENT_BUCKETS_CAN_SPAWN,
	SUBAGENT_BUCKET_CAN_SPAWN_ENV,
	canSpawnFromSubagentBucket,
	parseSubagentBucketCanSpawn,
} from "../src/bucket-config.js";

const ENV_KEYS = [
	"PIE_SUBAGENT_MAX_DEPTH",
	"PIE_SUBAGENT_MAX_TREE_SESSIONS",
	"PIE_SUBAGENT_PROVIDER_DEFAULTS_JSON",
	"PIE_SUBAGENT_PROVIDER_TOGGLES_BY_SESSION_JSON",
	SUBAGENT_BUCKET_CAN_SPAWN_ENV,
] as const;
const snapshot: Record<string, string | undefined> = {};

test.before(() => {
	for (const key of ENV_KEYS) snapshot[key] = process.env[key];
});
test.after(() => {
	for (const key of ENV_KEYS) {
		if (snapshot[key] === undefined) delete process.env[key];
		else process.env[key] = snapshot[key];
	}
});

const noSignal = () => new AbortController().signal;
const noOpUpdate = () => {};

/** Minimal model registry stub — setupModelSelection() only needs getAvailable(). */
function stubRegistry() {
	const model = { id: "model-a", provider: "test" } as any;
	return { getAvailable: () => [model] } as any;
}

// ============================================================
// disallowedByCanSpawn — pure caller-allowlist check
// ============================================================

test("disallowedByCanSpawn: undefined canSpawn → unrestricted (empty)", () => {
	assert.deepEqual(disallowedByCanSpawn(undefined, new Set(["worker", "scout"])), []);
});

test("disallowedByCanSpawn: empty canSpawn → blocks everything requested", () => {
	assert.deepEqual(disallowedByCanSpawn([], new Set(["worker"])), ["worker"]);
});

test("disallowedByCanSpawn: permitted name is not disallowed", () => {
	assert.deepEqual(disallowedByCanSpawn(["scout"], new Set(["scout"])), []);
});

test("disallowedByCanSpawn: name not in allowlist is disallowed", () => {
	assert.deepEqual(disallowedByCanSpawn(["scout"], new Set(["worker"])), ["worker"]);
});

test("disallowedByCanSpawn: mixed request — only the disallowed ones returned", () => {
	assert.deepEqual(disallowedByCanSpawn(["scout", "reviewer"], new Set(["scout", "worker", "reviewer"])), ["worker"]);
});

// ============================================================
// getMaxDepth — env-configurable nesting depth
// ============================================================

test("getMaxDepth: unset → DEFAULT_MAX_DEPTH", () => {
	delete process.env.PIE_SUBAGENT_MAX_DEPTH;
	assert.equal(getMaxDepth(), DEFAULT_MAX_DEPTH);
	assert.equal(getMaxDepth(), MAX_DEPTH, "default must match the helpers MAX_DEPTH constant");
});

test("getMaxDepth: positive integer override is honoured", () => {
	process.env.PIE_SUBAGENT_MAX_DEPTH = "5";
	assert.equal(getMaxDepth(), 5);
});

test("getMaxDepth: non-numeric → default", () => {
	process.env.PIE_SUBAGENT_MAX_DEPTH = "deep";
	assert.equal(getMaxDepth(), DEFAULT_MAX_DEPTH);
});

test("getMaxDepth: 0 is honoured (subagents disabled)", () => {
	process.env.PIE_SUBAGENT_MAX_DEPTH = "0";
	assert.equal(getMaxDepth(), 0);
});

test("getMaxDepth: negative values fall back to default", () => {
	process.env.PIE_SUBAGENT_MAX_DEPTH = "-1";
	assert.equal(getMaxDepth(), DEFAULT_MAX_DEPTH);
});

test("getMaxDepth: float is floored", () => {
	process.env.PIE_SUBAGENT_MAX_DEPTH = "4.9";
	assert.equal(getMaxDepth(), 4);
});

// ============================================================
// getMaxTreeSessions — env-configurable tree-wide budget
// ============================================================

test("getMaxTreeSessions: unset → DEFAULT_MAX_TREE_SESSIONS", () => {
	delete process.env.PIE_SUBAGENT_MAX_TREE_SESSIONS;
	assert.equal(getMaxTreeSessions(), DEFAULT_MAX_TREE_SESSIONS);
});

test("getMaxTreeSessions: positive integer override is honoured", () => {
	process.env.PIE_SUBAGENT_MAX_TREE_SESSIONS = "7";
	assert.equal(getMaxTreeSessions(), 7);
});

test("getMaxTreeSessions: invalid → default", () => {
	process.env.PIE_SUBAGENT_MAX_TREE_SESSIONS = "lots";
	assert.equal(getMaxTreeSessions(), DEFAULT_MAX_TREE_SESSIONS);
});

// ============================================================
// consumeTreeSlot — shared tree-wide counter
// ============================================================

test("consumeTreeSlot: missing budget is a no-op pass-through", () => {
	assert.equal(consumeTreeSlot(undefined), undefined);
});

test("consumeTreeSlot: under cap returns undefined; over cap returns error message", () => {
	process.env.PIE_SUBAGENT_MAX_TREE_SESSIONS = "2";
	const budget = { sessions: 0 };
	assert.equal(consumeTreeSlot(budget), undefined, "1st slot (sessions=1)");
	assert.equal(budget.sessions, 1);
	assert.equal(consumeTreeSlot(budget), undefined, "2nd slot (sessions=2, at cap)");
	assert.equal(budget.sessions, 2);
	const err = consumeTreeSlot(budget);
	assert.ok(err, "3rd slot must exceed the cap");
	assert.match(err!, /tree session limit reached/i);
	assert.match(err!, /max 2/);
});

// ============================================================
// Nested provider-policy inheritance
// ============================================================

test("nested calls inherit the root chat's effective subagent provider policy", () => {
	process.env.PIE_SUBAGENT_PROVIDER_DEFAULTS_JSON = JSON.stringify({
		"openai-codex": false,
		umans: true,
	});
	process.env.PIE_SUBAGENT_PROVIDER_TOGGLES_BY_SESSION_JSON = JSON.stringify({
		"C:\\sessions\\root.jsonl": { "openai-codex": true, umans: false },
	});
	const runtime = { depth: 0, trail: [] };
	assert.deepEqual(
		resolveTreeSubagentProviderToggles(runtime, "c:/sessions/root.jsonl"),
		{ "openai-codex": true, umans: false },
	);

	// A nested AgentSession has an in-memory session manager and may run after
	// the environment changes. Its tree policy must remain the root snapshot.
	process.env.PIE_SUBAGENT_PROVIDER_DEFAULTS_JSON = JSON.stringify({
		"openai-codex": true,
		umans: true,
	});
	assert.deepEqual(
		resolveTreeSubagentProviderToggles(runtime, undefined),
		{ "openai-codex": true, umans: false },
	);
});

// ============================================================
// Per-bucket delegation policy
// ============================================================

test("bucket delegation parsing defaults fail-open and preserves explicit leaves", () => {
	assert.deepEqual(parseSubagentBucketCanSpawn(undefined), ALL_SUBAGENT_BUCKETS_CAN_SPAWN);
	assert.deepEqual(parseSubagentBucketCanSpawn("not-json"), ALL_SUBAGENT_BUCKETS_CAN_SPAWN);
	assert.deepEqual(
		parseSubagentBucketCanSpawn('{"small":false,"medium":false,"frontier":true}'),
		{ small: false, medium: false, frontier: true },
	);
	assert.deepEqual(
		parseSubagentBucketCanSpawn('{"small":false,"medium":"invalid"}'),
		{ small: false, medium: true, frontier: true },
	);
});

// ============================================================
// execute() integration — dispatch guards
// ============================================================

test("execute: a caller in a disabled bucket cannot dispatch another subagent", async () => {
	delete process.env.PIE_SUBAGENT_MAX_DEPTH;
	process.env[SUBAGENT_BUCKET_CAN_SPAWN_ENV] = JSON.stringify({
		small: false,
		medium: false,
		frontier: true,
	});
	const res: any = await subagentRuntime.run(
		{ depth: 1, trail: ["worker"], bucket: "medium", budget: { sessions: 0 } },
		() => execute(
			"tc-bucket-leaf",
			{ agent: "worker", task: "delegate again" } as any,
			noSignal(),
			noOpUpdate,
			{ cwd: process.cwd() } as any,
			{} as any,
			() => false,
		),
	);
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /"medium" bucket are not allowed to create further subagents/);
	assert.equal(res.details.results.length, 0);
});

test("root callers remain unrestricted by per-bucket delegation policy", () => {
	process.env[SUBAGENT_BUCKET_CAN_SPAWN_ENV] = JSON.stringify({
		small: false,
		medium: false,
		frontier: false,
	});
	assert.equal(canSpawnFromSubagentBucket(undefined), true);
});

test("execute: caller canSpawn allowlist blocks a disallowed agent before dispatch", async () => {
	delete process.env[SUBAGENT_BUCKET_CAN_SPAWN_ENV];
	// Simulate running inside a `scout` session whose canSpawn only permits `scout`.
	// Requesting `worker` (which exists in the repo agents dir) must be blocked.
	delete process.env.PIE_SUBAGENT_MAX_DEPTH;
	const res: any = await subagentRuntime.run(
		{ depth: 1, trail: ["scout"], canSpawn: ["scout"], budget: { sessions: 0 } },
		() =>
			execute(
				"tc-canspawn",
				{ agent: "worker", task: "mutate things" } as any,
				noSignal(),
				noOpUpdate,
				{ cwd: process.cwd() } as any,
				{} as any,
				() => false,
			),
	);
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /blocked by the caller's canSpawn allowlist/);
	assert.match(res.content[0].text, /"worker"/);
	assert.equal(res.details.results.length, 0);
});

test("execute: maxDepth 0 short-circuits with disabled response", async () => {
	process.env.PIE_SUBAGENT_MAX_DEPTH = "0";
	const res: any = await subagentRuntime.run({ depth: 0, trail: [], budget: { sessions: 0 } }, () =>
		execute(
			"tc-disabled",
			{ agent: "worker", task: "x" } as any,
			noSignal(),
			noOpUpdate,
			{ cwd: process.cwd() } as any,
			{} as any,
			() => false,
		),
	);
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /Subagents are disabled/i);
});

test("execute: configurable depth overrides the default limit message", async () => {
	process.env.PIE_SUBAGENT_MAX_DEPTH = "2";
	const res: any = await subagentRuntime.run({ depth: 2, trail: [] }, () =>
		execute(
			"tc-depth",
			{ agent: "worker", task: "x" } as any,
			noSignal(),
			noOpUpdate,
			{ cwd: process.cwd() } as any,
			{} as any,
			() => false,
		),
	);
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /depth limit reached/i);
	assert.match(res.content[0].text, /max 2/);
});

test("execute: tree budget exhaustion surfaces the tree-limit error", async () => {
	process.env.PIE_SUBAGENT_MAX_TREE_SESSIONS = "1";
	// Pre-seed the shared budget so the single-mode slot consumption (the first
	// slot this call would consume) already exceeds the cap of 1.
	await assert.rejects(
		() => subagentRuntime.run(
			{ depth: 0, trail: [], budget: { sessions: 1 } },
			() => execute(
				"tc-tree",
				{ agent: "worker", task: "x" } as any,
				noSignal(),
				noOpUpdate,
				{ cwd: process.cwd(), modelRegistry: stubRegistry() } as any,
				{} as any,
				() => false,
			),
		),
		/tree session limit reached.*max 1/i,
	);
});
