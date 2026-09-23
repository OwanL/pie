/**
 * Tests for the nested-bucket cap: a user-configurable per-tier allowlist that
 * restricts which buckets *nested* subagents (depth ≥ 1) may use. When a nested
 * subagent requests a disallowed tier, the selector downgrades to the highest
 * allowed tier at or below the request (frontier → medium → small); if none are
 * allowed at/below, it uses the cheapest allowed tier overall; if nothing is
 * allowed at all, it falls back to the parent's active model.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
	downgradeBucketForNested,
	parseNestedAllowedBuckets,
	readNestedAllowedBuckets,
	NESTED_ALLOWED_BUCKETS_ENV,
	ALL_NESTED_BUCKETS_ALLOWED,
	type NestedAllowedBuckets,
} from "../bucket-selector.js";
import { resolveModel, type SelectionContext } from "../src/execute.js";
import type { AgentConfig } from "../agents.js";

const ENV_KEYS = [NESTED_ALLOWED_BUCKETS_ENV] as const;
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

const ALL: NestedAllowedBuckets = { small: true, medium: true, frontier: true };
const NO_FRONTIER: NestedAllowedBuckets = { small: true, medium: true, frontier: false };
const ONLY_SMALL: NestedAllowedBuckets = { small: true, medium: false, frontier: false };
const ONLY_MEDIUM: NestedAllowedBuckets = { small: false, medium: true, frontier: false };
const ONLY_FRONTIER: NestedAllowedBuckets = { small: false, medium: false, frontier: true };
const NONE: NestedAllowedBuckets = { small: false, medium: false, frontier: false };

function assignedModels(...models: string[]) {
	return models.map((model) => ({ model, thinkingLevel: "high" as const }));
}

// ============================================================
// downgradeBucketForNested — pure tier resolution
// ============================================================

test("downgradeBucketForNested: requested tier allowed → unchanged", () => {
	assert.deepEqual(downgradeBucketForNested("frontier", ALL), { bucket: "frontier", downgraded: false });
	assert.deepEqual(downgradeBucketForNested("medium", ALL), { bucket: "medium", downgraded: false });
	assert.deepEqual(downgradeBucketForNested("small", ALL), { bucket: "small", downgraded: false });
});

test("downgradeBucketForNested: opus requested but disallowed → sonnet (highest allowed at/below)", () => {
	assert.deepEqual(downgradeBucketForNested("frontier", NO_FRONTIER), { bucket: "medium", downgraded: true });
});

test("downgradeBucketForNested: opus requested, only haiku allowed → haiku", () => {
	assert.deepEqual(downgradeBucketForNested("frontier", ONLY_SMALL), { bucket: "small", downgraded: true });
});

test("downgradeBucketForNested: sonnet requested but disallowed, haiku allowed → haiku", () => {
	assert.deepEqual(downgradeBucketForNested("medium", ONLY_SMALL), { bucket: "small", downgraded: true });
});

test("downgradeBucketForNested: no tier allowed at/below the request → cheapest allowed above (upgrade)", () => {
	// medium requested, only frontier allowed → frontier (cheapest allowed above)
	assert.deepEqual(downgradeBucketForNested("medium", ONLY_FRONTIER), { bucket: "frontier", downgraded: true });
	// small requested, medium+frontier allowed → medium (cheapest allowed above)
	assert.deepEqual(downgradeBucketForNested("small", { small: false, medium: true, frontier: true }), { bucket: "medium", downgraded: true });
	// small requested, only frontier allowed → frontier
	assert.deepEqual(downgradeBucketForNested("small", ONLY_FRONTIER), { bucket: "frontier", downgraded: true });
});

test("downgradeBucketForNested: only sonnet allowed, haiku requested → sonnet (upgrade to cheapest allowed)", () => {
	assert.deepEqual(downgradeBucketForNested("small", ONLY_MEDIUM), { bucket: "medium", downgraded: true });
});

test("downgradeBucketForNested: no bucket allowed at all → empty (fall back to active model)", () => {
	assert.deepEqual(downgradeBucketForNested("frontier", NONE), { bucket: "", downgraded: true });
	assert.deepEqual(downgradeBucketForNested("medium", NONE), { bucket: "", downgraded: true });
	assert.deepEqual(downgradeBucketForNested("small", NONE), { bucket: "", downgraded: true });
});

test("downgradeBucketForNested: unknown requested tier is treated as medium", () => {
	// "huge" is not a known tier → treated as medium. With NO_FRONTIER (medium
	// allowed), medium is allowed → returned unchanged (not downgraded).
	assert.deepEqual(downgradeBucketForNested("huge", NO_FRONTIER), { bucket: "medium", downgraded: false });
	// Unknown tier, only small allowed → treated-as-medium not allowed → small.
	assert.deepEqual(downgradeBucketForNested("huge", ONLY_SMALL), { bucket: "small", downgraded: true });
});

// ============================================================
// parseNestedAllowedBuckets / readNestedAllowedBuckets — env parsing
// ============================================================

test("parseNestedAllowedBuckets: undefined/empty/malformed → all allowed (fail-open)", () => {
	assert.deepEqual(parseNestedAllowedBuckets(undefined), ALL_NESTED_BUCKETS_ALLOWED);
	assert.deepEqual(parseNestedAllowedBuckets(""), ALL_NESTED_BUCKETS_ALLOWED);
	assert.deepEqual(parseNestedAllowedBuckets("not-json"), ALL_NESTED_BUCKETS_ALLOWED);
});

test("parseNestedAllowedBuckets: non-object payload → all allowed", () => {
	assert.deepEqual(parseNestedAllowedBuckets("[]"), ALL_NESTED_BUCKETS_ALLOWED);
	assert.deepEqual(parseNestedAllowedBuckets('42'), ALL_NESTED_BUCKETS_ALLOWED);
	assert.deepEqual(parseNestedAllowedBuckets('"frontier"'), ALL_NESTED_BUCKETS_ALLOWED);
});

test("parseNestedAllowedBuckets: missing keys default to allowed", () => {
	assert.deepEqual(parseNestedAllowedBuckets('{"frontier":false}'), { small: true, medium: true, frontier: false });
});

test("parseNestedAllowedBuckets: non-boolean values are ignored (treated as allowed)", () => {
	assert.deepEqual(parseNestedAllowedBuckets('{"frontier":"no","medium":1}'), ALL_NESTED_BUCKETS_ALLOWED);
});

test("parseNestedAllowedBuckets: well-formed value is honoured", () => {
	assert.deepEqual(
		parseNestedAllowedBuckets('{"small":true,"medium":true,"frontier":false}'),
		{ small: true, medium: true, frontier: false },
	);
});

test("readNestedAllowedBuckets: env unset → all allowed", () => {
	delete process.env[NESTED_ALLOWED_BUCKETS_ENV];
	assert.deepEqual(readNestedAllowedBuckets(), ALL_NESTED_BUCKETS_ALLOWED);
});

test("readNestedAllowedBuckets: env set → parsed", () => {
	process.env[NESTED_ALLOWED_BUCKETS_ENV] = '{"frontier":false,"medium":true,"small":true}';
	assert.deepEqual(readNestedAllowedBuckets(), { small: true, medium: true, frontier: false });
});

// ============================================================
// resolveModel — nested-cap integration
// ============================================================

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "test",
		systemPrompt: "",
		source: "user",
		filePath: "worker.md",
		bucket: "medium",
		...overrides,
	};
}

function makeSelectionCtx(overrides: Partial<SelectionContext> = {}): SelectionContext {
	return {
		modelConfig: [],
		disabledProviders: new Set(),
		allowedModelIds: undefined,
		bucketAssignments: {
			small: assignedModels("haiku"),
			medium: assignedModels("sonnet"),
			frontier: assignedModels("opus"),
		},
		alwaysParentModel: false,
		nestedAllowedBuckets: { ...ALL_NESTED_BUCKETS_ALLOWED },
		...overrides,
	};
}

test("resolveModel: childDepth omitted → no downgrade even when allowlist restricts (back-compat)", async () => {
	const agent = makeAgent();
	const ctx = makeSelectionCtx({ nestedAllowedBuckets: NO_FRONTIER });
	const resolved = await resolveModel(agent, ctx, "parent-model", "frontier");
	// No childDepth → cap not applied → frontier honored.
	assert.equal(resolved.bucket, "frontier");
	assert.equal(resolved.modelOverride, "opus");
	assert.equal(resolved.bucketDowngradeReason, undefined);
});

test("resolveModel: childDepth 0 (root) → no downgrade", async () => {
	const agent = makeAgent();
	const ctx = makeSelectionCtx({ nestedAllowedBuckets: NO_FRONTIER });
	const resolved = await resolveModel(agent, ctx, "parent-model", "frontier", undefined, 0);
	assert.equal(resolved.bucket, "frontier");
	assert.equal(resolved.modelOverride, "opus");
	assert.equal(resolved.bucketDowngradeReason, undefined);
});

test("resolveModel: childDepth ≥ 1 + opus disallowed → downgraded to sonnet with diagnostic", async () => {
	const agent = makeAgent();
	const ctx = makeSelectionCtx({ nestedAllowedBuckets: NO_FRONTIER });
	const resolved = await resolveModel(agent, ctx, "parent-model", "frontier", undefined, 1);
	assert.equal(resolved.bucket, "medium");
	assert.equal(resolved.modelOverride, "sonnet");
	assert.equal(resolved.selection.fallback, false);
	assert.match(resolved.bucketDowngradeReason!, /downgraded to "medium"/);
	assert.match(resolved.bucketDowngradeReason!, /depth 1/);
});

test("resolveModel: childDepth ≥ 1 + requested tier allowed → no downgrade", async () => {
	const agent = makeAgent();
	const ctx = makeSelectionCtx({ nestedAllowedBuckets: NO_FRONTIER });
	const resolved = await resolveModel(agent, ctx, "parent-model", "medium", undefined, 2);
	assert.equal(resolved.bucket, "medium");
	assert.equal(resolved.modelOverride, "sonnet");
	assert.equal(resolved.bucketDowngradeReason, undefined);
});

test("resolveModel: childDepth ≥ 1 + no bucket allowed → falls back to active model with diagnostic", async () => {
	const agent = makeAgent();
	const ctx = makeSelectionCtx({ nestedAllowedBuckets: NONE });
	const resolved = await resolveModel(agent, ctx, "parent-model", "frontier", undefined, 1);
	assert.equal(resolved.modelOverride, "parent-model");
	assert.equal(resolved.selection.fallback, true);
	assert.equal(resolved.selection.pool.length, 0);
	assert.match(resolved.bucketDowngradeReason!, /no bucket is allowed/);
});

test("resolveModel: alwaysParentModel short-circuits before the nested cap (no downgrade reason)", async () => {
	const agent = makeAgent();
	const ctx = makeSelectionCtx({ alwaysParentModel: true, nestedAllowedBuckets: NO_FRONTIER });
	const resolved = await resolveModel(agent, ctx, "parent-model", "frontier", undefined, 1);
	assert.equal(resolved.modelOverride, "parent-model");
	assert.equal(resolved.selection.fallback, true);
	assert.equal(resolved.bucketDowngradeReason, undefined);
});

test("resolveModel: nested cap coexists with bucket pool (downgraded tier still selects from its pool)", async () => {
	const agent = makeAgent({ bucket: "frontier" }); // agent default = opus
	const ctx = makeSelectionCtx({ nestedAllowedBuckets: NO_FRONTIER });
	// No per-call bucket → uses agent.bucket ("frontier") → downgraded to medium.
	const resolved = await resolveModel(agent, ctx, "parent-model", undefined, undefined, 1);
	assert.equal(resolved.bucket, "medium");
	assert.equal(resolved.modelOverride, "sonnet");
	assert.deepEqual(resolved.selection.pool, ["sonnet"]);
});
