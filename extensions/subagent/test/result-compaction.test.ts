import test from "node:test";
import assert from "node:assert/strict";
import { compactSingleResult, MAX_SUBAGENT_OUTPUT_CHARS } from "../src/result-compaction.js";
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

test("compactSingleResult stores final prose once and preserves modifying tool calls", () => {
	const original = result([
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private reasoning".repeat(1_000) },
				{ type: "text", text: "intermediate ".repeat(1_000) },
				{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "/repo/a.ts", oldText: "a", newText: "b" } },
			],
		},
		{ role: "toolResult", toolCallId: "edit-1", toolName: "edit", content: [{ type: "text", text: "ok" }] },
		{ role: "assistant", content: [{ type: "text", text: "final answer" }] },
	]);

	const compacted = compactSingleResult(original);
	assert.equal(compacted.finalOutput, "final answer");
	assert.equal(compacted.transcriptCompacted, true);
	assert.equal(JSON.stringify(compacted.messages).includes("private reasoning"), false);
	assert.equal(JSON.stringify(compacted.messages).includes("final answer"), false, "final prose is not duplicated in messages");
	const encoded = JSON.stringify(compacted.messages);
	assert.match(encoded, /\"name\":\"edit\"/);
	assert.match(encoded, /\/repo\/a\.ts/);
	assert.equal(encoded.includes("oldText"), false);
	assert.deepEqual(compacted.fileChanges, [{
		path: "/repo/a.ts", kind: "modified", description: "edited", additions: 1, deletions: 1,
	}]);
	assert.equal(original.messages[2].content[0].text, "final answer", "live result is not mutated");
});

test("compactSingleResult bounds final output and terminalizes live-only state", () => {
	const compacted = compactSingleResult(result([], {
		streaming: true,
		streamingText: "x".repeat(MAX_SUBAGENT_OUTPUT_CHARS + 100),
		streamingReasoning: "reasoning",
		runningTools: ["bash"],
	}));
	assert.ok((compacted.finalOutput?.length ?? 0) < MAX_SUBAGENT_OUTPUT_CHARS + 100);
	assert.match(compacted.finalOutput ?? "", /chars omitted/);
	assert.equal(compacted.streaming, false);
	assert.equal(compacted.streamingText, undefined);
	assert.equal(compacted.streamingReasoning, undefined);
});

test("compactSingleResult recursively compacts nested subagent details", () => {
	const child = result([{ role: "assistant", content: [{ type: "text", text: "nested final" }] }]);
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

	const compacted = compactSingleResult(parent) as any;
	const nested = compacted.messages[0].details.results[0];
	assert.equal(nested.finalOutput, "nested final");
	assert.equal(nested.transcriptCompacted, true);
	assert.equal(JSON.stringify(nested.messages).includes("nested final"), false);
});
