/**
 * Focused regression tests for the pie "all subagent providers unchecked"
 * policy signal: execute() must refuse to spawn (stale-execution guard) while
 * every provider in the toggle surface is unchecked, while still preserving
 * unspecified/default-enabled semantics and the running-tree snapshot
 * (descendants consume the root snapshot and are not cancelled mid-flight).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { subagentRuntime } from "../runner.js";
import { execute, resolveTreeSubagentProviderToggles } from "../src/execute.js";
import { SUBAGENT_BUCKETS_ENV, SUBAGENT_BUCKET_CAN_SPAWN_ENV } from "../src/bucket-config.js";
import { subagentProvidersAllDisabledFromEnv } from "../src/provider-toggles.js";

const ENV_KEYS = [
	"PIE_SUBAGENT_MAX_DEPTH",
	"PIE_SUBAGENT_PROVIDER_DEFAULTS_JSON",
	"PIE_SUBAGENT_PROVIDER_TOGGLES_BY_SESSION_JSON",
	SUBAGENT_BUCKETS_ENV,
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

const registry = () => {
	const model = { id: "model-a", provider: "test" } as any;
	return { getAvailable: () => [model] } as any;
};

const rootCall = (registryOverride?: unknown) =>
	execute(
		"tc-provider-policy",
		{ agent: "worker", task: "x" } as any,
		noSignal(),
		noOpUpdate,
		{ cwd: process.cwd(), modelRegistry: registryOverride ?? registry() } as any,
		{} as any,
		() => false,
	);

test("subagentProvidersAllDisabledFromEnv: empty surface stays enabled", () => {
	delete process.env[SUBAGENT_BUCKETS_ENV];
	delete process.env.PIE_SUBAGENT_PROVIDER_DEFAULTS_JSON;
	assert.equal(subagentProvidersAllDisabledFromEnv({}, registry()), false);
});

test("subagentProvidersAllDisabledFromEnv: all-unchecked holds with buckets", () => {
	process.env[SUBAGENT_BUCKETS_ENV] = JSON.stringify({
		small: [{ model: "anthropic/haiku", thinkingLevel: "off" }],
		medium: [],
		frontier: [],
	});
	process.env.PIE_SUBAGENT_PROVIDER_DEFAULTS_JSON = JSON.stringify({ anthropic: false });
	assert.equal(subagentProvidersAllDisabledFromEnv({ anthropic: false }, registry()), true);
	// Unspecified providers (missing entries) remain enabled by default.
	assert.equal(subagentProvidersAllDisabledFromEnv({ anthropic: true }, registry()), false);
});

test("execute: all providers unchecked returns the provider-disabled response before discovery", async () => {
	delete process.env.PIE_SUBAGENT_MAX_DEPTH;
	process.env[SUBAGENT_BUCKETS_ENV] = JSON.stringify({
		small: [{ model: "anthropic/haiku", thinkingLevel: "off" }],
		medium: [],
		frontier: [],
	});
	process.env.PIE_SUBAGENT_PROVIDER_DEFAULTS_JSON = JSON.stringify({ anthropic: false });
	const res: any = await execute(
		"tc-all-unchecked",
		{ agent: "worker", task: "x" } as any,
		noSignal(),
		noOpUpdate,
		{ cwd: process.cwd(), modelRegistry: registry() } as any,
		{} as any,
		() => false,
	);
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /every subagent provider is unchecked/);
	assert.equal(res.details.results.length, 0);
});

test("execute: an effectively enabled provider passes the guard (reaches later dispatch)", async () => {
	delete process.env.PIE_SUBAGENT_MAX_DEPTH;
	delete process.env[SUBAGENT_BUCKETS_ENV];
	process.env.PIE_SUBAGENT_PROVIDER_DEFAULTS_JSON = JSON.stringify({
		"openai-codex": false,
		umans: true,
	});
	// Nested caller in a leaf bucket so the call fails deterministically at the
	// delegation guard — proving it got PAST the provider guard — without
	// spawning any child session.
	process.env[SUBAGENT_BUCKET_CAN_SPAWN_ENV] = JSON.stringify({
		small: false,
		medium: true,
		frontier: true,
	});
	const res: any = await subagentRuntime.run(
		{ depth: 1, trail: ["worker"], bucket: "small", budget: { sessions: 0 } },
		() => execute(
			"tc-provider-enabled",
			{ agent: "worker", task: "delegate again" } as any,
			noSignal(),
			noOpUpdate,
			{ cwd: process.cwd(), modelRegistry: registry() } as any,
			{} as any,
			() => false,
		),
	);
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /"small" bucket are not allowed to create further subagents/);
});

test("execute: nested calls consume the root tree snapshot, not fresh preferences", async () => {
	delete process.env.PIE_SUBAGENT_MAX_DEPTH;
	delete process.env[SUBAGENT_BUCKETS_ENV];
	process.env.PIE_SUBAGENT_PROVIDER_DEFAULTS_JSON = JSON.stringify({ anthropic: true });
	const rootSessionPath = "c:/sessions/root.jsonl";
	// The root call resolves and caches the tree snapshot while anthropic is enabled.
	const rootRuntimeCtx = { depth: 0, trail: [] } as any;
	const rootSnapshot = resolveTreeSubagentProviderToggles(rootRuntimeCtx, rootSessionPath);

	// Preferences flip to all-unchecked after the snapshot was taken.
	process.env.PIE_SUBAGENT_PROVIDER_DEFAULTS_JSON = JSON.stringify({ anthropic: false });

	// A nested call in the same tree consumes the root snapshot and stays enabled.
	const nestedSnapshot = resolveTreeSubagentProviderToggles(rootRuntimeCtx, rootSessionPath);
	assert.deepEqual(nestedSnapshot, rootSnapshot);
	assert.equal(subagentProvidersAllDisabledFromEnv(nestedSnapshot, registry()), false);

	// A fresh root call after the flip resolves the new policy and is blocked.
	const freshSnapshot = resolveTreeSubagentProviderToggles({ depth: 0, trail: [] } as any, rootSessionPath);
	assert.equal(subagentProvidersAllDisabledFromEnv(freshSnapshot, registry()), true);
});

test("execute: root call resolves its session's per-session overrides", async () => {
	delete process.env.PIE_SUBAGENT_MAX_DEPTH;
	delete process.env[SUBAGENT_BUCKETS_ENV];
	delete process.env.PIE_SUBAGENT_PROVIDER_DEFAULTS_JSON;
	// Only this session's overrides make the surface all-unchecked; the
	// defaults map is empty (unspecified → enabled elsewhere).
	process.env.PIE_SUBAGENT_PROVIDER_TOGGLES_BY_SESSION_JSON = JSON.stringify({
		"c:/sessions/root.jsonl": { anthropic: false },
	});
	const ctx = {
		cwd: process.cwd(),
		modelRegistry: registry(),
		sessionManager: { getSessionFile: () => "C:/SESSIONS/ROOT.jsonl" },
	} as any;
	const res: any = await execute(
		"tc-session-overrides",
		{ agent: "worker", task: "x" } as any,
		noSignal(),
		noOpUpdate,
		ctx,
		{} as any,
		() => false,
	);
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /every subagent provider is unchecked/);
});