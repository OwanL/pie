import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { BUCKET_GUIDANCE, SubagentParams, prepareSubagentArguments } from "../schema.js";

test("BUCKET_GUIDANCE describes every model bucket", () => {
	assert.match(BUCKET_GUIDANCE, /small/);
	assert.match(BUCKET_GUIDANCE, /medium/);
	assert.match(BUCKET_GUIDANCE, /frontier/);
});

test("SubagentParams exposes one required task shape", () => {
	assert.equal(SubagentParams.type, "object");
	assert.deepEqual(SubagentParams.required, ["agent", "task"]);
	const props = SubagentParams.properties as Record<string, unknown>;
	assert.deepEqual(Object.keys(props), [
		"agent", "task", "userContext", "confirmProjectAgents", "cwd", "bucket", "thinkingLevel",
	]);
	assert.equal("tasks" in props, false);
	assert.equal("chain" in props, false);
	assert.equal("agentScope" in props, false);
});

test("SubagentParams enum and default metadata remain intact", () => {
	const props = SubagentParams.properties as Record<string, any>;
	assert.deepEqual(props.bucket.enum, ["small", "medium", "frontier"]);
	assert.equal(props.bucket.default, "medium");
	assert.deepEqual(props.thinkingLevel.enum, ["minimal", "low", "medium", "high", "xhigh"]);
	assert.deepEqual(props.userContext.enum, ["latest", "all"]);
	assert.equal(props.userContext.default, undefined);
	assert.equal(props.confirmProjectAgents.default, true);
});

test("userContext guidance binds each mode to its condition within its prompt budget", () => {
	const description = (SubagentParams.properties as Record<string, any>).userContext.description as string;
	const modes = description.split("; ");
	assert.equal(modes.length, 3);
	const [omit, latest, all] = modes;

	assert.match(omit, /\bomit\b.*\bself-contained tasks\b/i);
	assert.match(latest, /^'latest'\s.*\bcurrent request\b.*\bclarifications\b/);
	assert.match(all, /^'all'\s.*\brequirements span multiple user turns\b/);
	assert.ok(description.length <= 200, "userContext guidance must remain within its permanent 200-character prompt budget");
});

test("SubagentParams accepts a valid single task", () => {
	assert.equal(Value.Check(SubagentParams, {
		agent: "worker",
		task: "do work",
		userContext: "latest",
		confirmProjectAgents: true,
		cwd: "/repo",
		bucket: "medium",
		thinkingLevel: "low",
	}), true);
});

test("prepareSubagentArguments migrates only one-item legacy batches", () => {
	assert.deepEqual(prepareSubagentArguments({ tasks: [{ agent: "worker", task: "a", bucket: "small" }], userContext: "all" }), {
		agent: "worker", task: "a", bucket: "small", userContext: "all",
	});
	assert.deepEqual(prepareSubagentArguments({ chain: [{ agent: "worker", task: "a" }] }), {
		agent: "worker", task: "a",
	});
	assert.throws(
		() => prepareSubagentArguments({ tasks: [{ agent: "a", task: "1" }, { agent: "b", task: "2" }] }),
		/use.*sibling subagent calls|sibling subagent calls/i,
	);
});

test("SubagentParams rejects removed routes and malformed values", () => {
	assert.equal(Value.Check(SubagentParams, { tasks: [{ agent: "worker", task: "a" }] }), false);
	assert.equal(Value.Check(SubagentParams, { chain: [{ agent: "worker", task: "a" }] }), false);
	assert.equal(Value.Check(SubagentParams, { agent: "worker", task: "a", tasks: [] }), false);
	assert.equal(Value.Check(SubagentParams, { agent: "worker", task: "a", bucket: "huge" }), false);
	assert.equal(Value.Check(SubagentParams, { agent: "worker", task: "a", userContext: "full" }), false);
	assert.equal(Value.Check(SubagentParams, { agent: "worker" }), false);
	assert.equal(Value.Check(SubagentParams, { task: "a" }), false);
});
