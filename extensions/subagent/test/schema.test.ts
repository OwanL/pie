import test from "node:test";
import assert from "node:assert/strict";
import { BUCKET_GUIDANCE, SubagentParams } from "../schema.js";

test("BUCKET_GUIDANCE is the exact non-empty string surfaced to users", () => {
	const expected =
		"Bucket hint for model selection: 'small' (Haiku-class, busywork), 'medium' (Sonnet-class, main development), or 'frontier' (Opus-class, hardest problems). Prefer 'medium' for almost all tasks — it is the best balance of cost and capability. Reserve 'frontier' for only the absolute hardest problems, as it is far more expensive; use 'small' only for trivial busywork. Defaults to 'medium' when omitted.";
	assert.equal(BUCKET_GUIDANCE, expected);
	assert.ok(BUCKET_GUIDANCE.length > 0, "BUCKET_GUIDANCE must be non-empty");
	assert.match(BUCKET_GUIDANCE, /small/);
	assert.match(BUCKET_GUIDANCE, /medium/);
	assert.match(BUCKET_GUIDANCE, /frontier/);
});

test("SubagentParams is a TypeBox object schema with the expected required fields", () => {
	assert.equal(SubagentParams.kind, "Object");
	const required = new Set(SubagentParams.required as string[]);
	assert.equal(required.size, 0, "all top-level fields are optional");

	const props = SubagentParams.properties as Record<string, unknown>;
	assert.ok("agent" in props, "schema exposes agent");
	assert.ok("task" in props, "schema exposes task");
	assert.ok("tasks" in props, "schema exposes tasks");
	assert.ok("chain" in props, "schema exposes chain");
	assert.ok("agentScope" in props, "schema exposes agentScope");
	assert.ok("confirmProjectAgents" in props, "schema exposes confirmProjectAgents");
	assert.ok("cwd" in props, "schema exposes cwd");
	assert.ok("bucket" in props, "schema exposes bucket");
	assert.ok("thinkingLevel" in props, "schema exposes thinkingLevel");
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
	assert.equal(SubagentParams.Check(validSingle), true, "valid single-mode params should pass");
});

test("SubagentParams accepts a valid parallel-mode params object", () => {
	const validParallel = {
		tasks: [
			{ agent: "worker", task: "a", bucket: "small", thinkingLevel: "minimal" },
			{ agent: "reviewer", task: "b" },
		],
	};
	assert.equal(SubagentParams.Check(validParallel), true, "valid parallel params should pass");
});

test("SubagentParams accepts a valid chain-mode params object", () => {
	const validChain = {
		chain: [{ agent: "scout", task: "step 1" }, { agent: "worker", task: "step {previous}" }],
	};
	assert.equal(SubagentParams.Check(validChain), true, "valid chain params should pass");
});

test("SubagentParams rejects malformed params objects", () => {
	// bucket outside the allowed enum
	const badBucket = {
		agent: "worker",
		task: "do work",
		bucket: "huge",
	};
	assert.equal(SubagentParams.Check(badBucket), false, "invalid bucket value should fail");

	// agentScope outside the allowed enum
	const badScope = {
		agent: "worker",
		task: "do work",
		agentScope: "everywhere",
	};
	assert.equal(SubagentParams.Check(badScope), false, "invalid agentScope value should fail");

	// confirmProjectAgents not boolean
	const badConfirm = {
		agent: "worker",
		task: "do work",
		confirmProjectAgents: "yes",
	};
	assert.equal(SubagentParams.Check(badConfirm), false, "non-boolean confirmProjectAgents should fail");

	// tasks entry missing required task field
	const badParallel = {
		tasks: [{ agent: "worker" }],
	};
	assert.equal(SubagentParams.Check(badParallel), false, "parallel task missing task should fail");

	// Multiple modes at once (single + parallel)
	const multiMode = {
		agent: "worker",
		task: "single",
		tasks: [{ agent: "reviewer", task: "parallel" }],
	};
	assert.equal(SubagentParams.Check(multiMode), true, "schema-level validation allows multiple modes; business rule rejects later");
});

test("SubagentParams default metadata for bucket is medium", () => {
	const bucketSchema = (SubagentParams.properties as Record<string, any>).bucket;
	assert.equal(bucketSchema.default, "medium");
	assert.equal(bucketSchema.description, BUCKET_GUIDANCE);
});

test("SubagentParams default metadata for confirmProjectAgents is true", () => {
	const confirmSchema = (SubagentParams.properties as Record<string, any>).confirmProjectAgents;
	assert.equal(confirmSchema.default, true);
});
