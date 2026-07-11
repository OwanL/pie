import test from "node:test";
import assert from "node:assert/strict";
// `typebox/value` is typebox 1.1.38's runtime-validation entrypoint. Its
// package.json `./value` export ships no `types` field, so tsc resolves it to
// implicit any (like every other pi-SDK import in this tsconfig — `@mariozechner/pi-ai`,
// `@mariozechner/pi-agent-core`, etc. are all untyped here because pi's loader
// aliases them only at runtime). Runtime is fine: tsx loads the .mjs via the
// tsconfig path alias. The subagent tsconfig is not part of the repo's gated
// `typecheck` pipeline (extensions:typecheck excludes subagent).
import { Value } from "typebox/value";
import { BUCKET_GUIDANCE, SubagentParams } from "../schema.js";

// TypeBox v1 notes (the installed `@earendil-works/pi-ai` bundles typebox
// 1.1.38, which pi's loader aliases to the legacy `@mariozechner/pi-ai` import
// used by schema.ts): v1 `Type.Object(...)` no longer exposes the v0
// `[Symbol.for('TypeBox.Kind')]`/`.kind` field or a `.Check()` method on the
// schema itself. Runtime validation is `Value.Check(schema, value)` from the
// `typebox/value` entrypoint, and the schema is a plain JSON-Schema object
// (`type`, `properties`, `required`, `enum`, `default`, ...). The subagent
// extension never calls `.Check()` at runtime — pi consumes the JSON-Schema
// shape for the tool's `parameters` — so these assertions validate the shape
// pi actually uses plus v1 `Value.Check` for accept/reject behaviour. Both
// `StringEnum` and `Type` are sourced from the same `@mariozechner/pi-ai`
// entrypoint in schema.ts (see comment there) so `Value.Check` shares one
// TypeBox runtime with the schema; the subagent tsconfig path-aliases
// `@mariozechner/pi-ai` + `typebox`/`typebox/value` to that same bundled copy
// so plain `tsx` (no pi loader) resolves a single instance.

test("BUCKET_GUIDANCE is the exact non-empty string surfaced to users", () => {
	const expected =
		"Model bucket: 'small' for trivial work, 'medium' for normal development (default), or 'frontier' only for exceptional difficulty.";
	assert.equal(BUCKET_GUIDANCE, expected);
	assert.ok(BUCKET_GUIDANCE.length > 0, "BUCKET_GUIDANCE must be non-empty");
	assert.match(BUCKET_GUIDANCE, /small/);
	assert.match(BUCKET_GUIDANCE, /medium/);
	assert.match(BUCKET_GUIDANCE, /frontier/);
});

test("SubagentParams is a JSON-Schema object with all top-level fields optional", () => {
	assert.equal(SubagentParams.type, "object", "schema is a JSON-Schema object");
	const required = (SubagentParams.required as string[] | undefined) ?? [];
	assert.equal(required.length, 0, "all top-level fields are optional");

	const props = SubagentParams.properties as Record<string, unknown>;
	const expectedProps = [
		"agent",
		"task",
		"tasks",
		"chain",
		"agentScope",
		"confirmProjectAgents",
		"cwd",
		"bucket",
		"thinkingLevel",
	];
	for (const key of expectedProps) {
		assert.ok(key in props, `schema exposes ${key}`);
	}
});

test("SubagentParams enum fields carry the allowed values", () => {
	const props = SubagentParams.properties as Record<string, any>;
	assert.deepEqual(props.bucket?.enum, ["small", "medium", "frontier"]);
	assert.deepEqual(props.agentScope?.enum, ["user", "project", "both"]);
	assert.deepEqual(props.thinkingLevel?.enum, ["minimal", "low", "medium", "high", "xhigh"]);
});

test("SubagentParams default metadata for bucket is medium", () => {
	const bucketSchema = (SubagentParams.properties as Record<string, any>).bucket;
	assert.equal(bucketSchema.default, "medium");
	assert.equal(bucketSchema.description, BUCKET_GUIDANCE);
});

test("SubagentParams default metadata for confirmProjectAgents is true", () => {
	const confirmSchema = (SubagentParams.properties as Record<string, any>).confirmProjectAgents;
	assert.equal(confirmSchema.default, true);
	assert.equal(confirmSchema.type, "boolean");
});

test("tasks/chain items require agent + task and allow cwd/bucket/thinkingLevel", () => {
	const props = SubagentParams.properties as Record<string, any>;
	for (const field of ["tasks", "chain"]) {
		const items = props[field]?.items;
		assert.equal(items?.type, "object", `${field} items are objects`);
		assert.deepEqual(items?.required, ["agent", "task"], `${field} items require agent + task`);
		const itemProps = items?.properties as Record<string, unknown> | undefined;
		for (const key of ["agent", "task", "cwd", "bucket", "thinkingLevel"]) {
			assert.ok(itemProps && key in itemProps, `${field} item exposes ${key}`);
		}
	}
});

test("SubagentParams accepts a valid single-mode params object", () => {
	const validSingle = {
		agent: "worker",
		task: "do work",
		agentScope: "user",
		confirmProjectAgents: true,
		cwd: "/repo",
		bucket: "medium",
		thinkingLevel: "low",
	};
	assert.equal(Value.Check(SubagentParams, validSingle), true, "valid single-mode params should pass");
});

test("SubagentParams accepts a valid parallel-mode params object", () => {
	const validParallel = {
		tasks: [
			{ agent: "worker", task: "a", bucket: "small", thinkingLevel: "minimal" },
			{ agent: "reviewer", task: "b" },
		],
	};
	assert.equal(Value.Check(SubagentParams, validParallel), true, "valid parallel params should pass");
});

test("SubagentParams accepts a valid chain-mode params object", () => {
	const validChain = {
		chain: [{ agent: "scout", task: "step 1" }, { agent: "worker", task: "step {previous}" }],
	};
	assert.equal(Value.Check(SubagentParams, validChain), true, "valid chain params should pass");
});

test("SubagentParams rejects malformed params objects", () => {
	// bucket outside the allowed enum
	const badBucket = {
		agent: "worker",
		task: "do work",
		bucket: "huge",
	};
	assert.equal(Value.Check(SubagentParams, badBucket), false, "invalid bucket value should fail");

	// agentScope outside the allowed enum
	const badScope = {
		agent: "worker",
		task: "do work",
		agentScope: "everywhere",
	};
	assert.equal(Value.Check(SubagentParams, badScope), false, "invalid agentScope value should fail");

	// confirmProjectAgents not boolean
	const badConfirm = {
		agent: "worker",
		task: "do work",
		confirmProjectAgents: "yes",
	};
	assert.equal(Value.Check(SubagentParams, badConfirm), false, "non-boolean confirmProjectAgents should fail");

	// tasks entry missing required task field
	const badParallel = {
		tasks: [{ agent: "worker" }],
	};
	assert.equal(Value.Check(SubagentParams, badParallel), false, "parallel task missing task should fail");

	// Multiple modes at once (single + parallel) — schema-level validation
	// allows it; business-rule rejection happens later in execute/selection.
	const multiMode = {
		agent: "worker",
		task: "single",
		tasks: [{ agent: "reviewer", task: "parallel" }],
	};
	assert.equal(Value.Check(SubagentParams, multiMode), true, "schema-level validation allows multiple modes; business rule rejects later");
});
