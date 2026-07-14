import test from "node:test";
import assert from "node:assert/strict";
import {
	AGENT_SCOPE_VALUES,
	COLLAPSED_ITEM_COUNT,
	MAX_MODEL_RETRIES,
	TASK_PREVIEW_LONG,
	TASK_PREVIEW_SHORT,
} from "../types.js";

test("MAX_MODEL_RETRIES is a reasonable non-negative integer", () => {
	assert.ok(Number.isInteger(MAX_MODEL_RETRIES));
	assert.ok(MAX_MODEL_RETRIES >= 0);
	assert.ok(MAX_MODEL_RETRIES <= 10, "Retry cap above 10 is wasteful");
});

test("collapsed-item and task-preview constants are positive and ordered", () => {
	assert.ok(COLLAPSED_ITEM_COUNT > 0);
	assert.ok(TASK_PREVIEW_SHORT > 0);
	assert.ok(TASK_PREVIEW_LONG > 0);
	assert.ok(TASK_PREVIEW_SHORT <= TASK_PREVIEW_LONG);
});

test("AGENT_SCOPE_VALUES contains exactly the supported scope literals", () => {
	assert.deepEqual([...AGENT_SCOPE_VALUES].sort(), ["both", "project", "user"]);
	assert.ok(!AGENT_SCOPE_VALUES.has("User" as never));
	assert.ok(!AGENT_SCOPE_VALUES.has("" as never));
});
