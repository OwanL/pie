import test from "node:test";
import assert from "node:assert/strict";
import { compactSingleResult } from "../src/result-compaction.js";
import type { SingleResult } from "../types.js";

function result(messages: any[], over: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "worker",
		agentSource: "user",
		task: "work",
		exitCode: 0,
		messages,
		stderr: "",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
		...over,
	};
}

test("terminalization preserves complete reasoning, tool inputs/results, and final prose", () => {
	const original = result([
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "intermediate" },
				{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "/repo/a.ts", oldText: "a", newText: "b" } },
			],
		},
		{ role: "toolResult", toolCallId: "edit-1", toolName: "edit", content: [{ type: "text", text: "complete tool output" }] },
		{ role: "assistant", content: [{ type: "text", text: "final answer" }] },
	]);

	const terminal = compactSingleResult(original);
	const encoded = JSON.stringify(terminal.messages);
	assert.equal(terminal.finalOutput, "final answer");
	assert.equal(terminal.transcriptCompacted, false);
	assert.match(encoded, /private reasoning/);
	assert.match(encoded, /intermediate/);
	assert.match(encoded, /oldText/);
	assert.match(encoded, /complete tool output/);
	assert.match(encoded, /final answer/);
});

test("terminalization serializes completed nested tool results once while retaining running progress", () => {
	const completedResult = {
		content: [{ type: "text", text: "completed nested output" }],
		details: { mode: "single", results: [{ agent: "scout", messages: [] }] },
	};
	const runningResult = {
		content: [{ type: "text", text: "running nested output" }],
		details: { mode: "single", results: [{ agent: "reviewer", messages: [] }] },
	};
	const terminal = compactSingleResult(result([
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "completed", name: "subagent", arguments: {}, result: completedResult },
				{ type: "toolCall", id: "running", name: "subagent", arguments: {}, result: runningResult },
			],
		},
		{
			role: "toolResult",
			toolCallId: "completed",
			toolName: "subagent",
			content: completedResult.content,
			details: completedResult.details,
		},
	]));

	const assistantParts = (terminal.messages[0] as any).content;
	assert.equal(assistantParts[0].result, undefined, "matching toolResult owns the completed result");
	assert.match(
		JSON.stringify(assistantParts[1].result),
		/running nested output/,
		"inline progress remains when no toolResult exists",
	);
	assert.match(JSON.stringify(terminal.messages[1]), /completed nested output/);
	assert.equal(JSON.stringify(terminal.messages).match(/completed nested output/g)?.length, 1);
});

test("terminalization clears only live-only fields and does not cap output", () => {
	const longOutput = "x".repeat(100_000);
	const terminal = compactSingleResult(result([], {
		streaming: true,
		streamingText: longOutput,
		streamingReasoning: "reasoning",
		runningTools: ["bash"],
		finalOutput: longOutput,
	}));
	assert.equal(terminal.finalOutput, longOutput);
	assert.equal(terminal.streaming, false);
	assert.equal(terminal.streamingText, undefined);
	assert.equal(terminal.streamingReasoning, undefined);
	assert.deepEqual(terminal.runningTools, []);
	assert.equal(typeof terminal.completedAt, "number");
});

test("terminalization recursively preserves nested subagent details", () => {
	const child = result([{ role: "assistant", content: [{ type: "thinking", thinking: "nested reasoning" }, { type: "text", text: "nested final" }] }]);
	const parent = result([
		{
			role: "toolResult",
			toolCallId: "sa-1",
			toolName: "subagent",
			content: [{ type: "text", text: "nested final" }],
			details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [child] },
		},
		{ role: "assistant", content: [{ type: "text", text: "parent final" }] },
	]);

	const terminal = compactSingleResult(parent) as any;
	const nested = terminal.messages[0].details.results[0];
	assert.equal(nested.finalOutput, "nested final");
	assert.equal(nested.transcriptCompacted, false);
	assert.match(JSON.stringify(nested.messages), /nested reasoning/);
	assert.match(JSON.stringify(nested.messages), /nested final/);
});
