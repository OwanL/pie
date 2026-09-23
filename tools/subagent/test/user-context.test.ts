import test from "node:test";
import assert from "node:assert/strict";
import {
	MAX_USER_CONTEXT_CHARS,
	buildParentUserContext,
	formatSubagentPrompt,
	type ParentSessionManager,
} from "../src/user-context.js";

type SessionEntry = ReturnType<ParentSessionManager["getBranch"]>[number];

function entry(message: Record<string, unknown>, index: number): SessionEntry {
	return {
		type: "message",
		id: `entry-${index}`,
		parentId: index > 0 ? `entry-${index - 1}` : null,
		timestamp: new Date(index).toISOString(),
		message,
	} as SessionEntry;
}

function manager(branch: SessionEntry[]): ParentSessionManager {
	return { getBranch: () => branch } as unknown as ParentSessionManager;
}

function user(content: unknown) {
	return { role: "user", content, timestamp: 0 };
}

function askCall(id: string, question: string) {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "ask_user", arguments: { question, options: [] } }],
		timestamp: 0,
	};
}

function askResult(id: string, answer: string, details: Record<string, unknown> = {}) {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "ask_user",
		content: [{ type: "text", text: answer }],
		details: { answer, source: "custom", cancelled: false, ...details },
		isError: false,
		timestamp: 0,
	};
}

test("omitted userContext preserves task-only behavior", () => {
	assert.equal(buildParentUserContext(undefined, manager([])), undefined);
	const prompt = formatSubagentPrompt("inspect the parser");
	assert.match(prompt, /Traversal safety:/);
	assert.match(prompt, /Task: inspect the parser$/);
	assert.ok(prompt.indexOf("Traversal safety:") < prompt.indexOf("Task:"));
});

test("every task prompt embeds the canonical traversal-safety policy paragraph", () => {
	const prompt = formatSubagentPrompt("anything");
	for (const protectedClass of ["dependency", "version-control", "generated/build", "cache", "coverage", "runtime-data", "session", "log", "packaged-artifact", "temporary-SDK"]) {
		assert.match(prompt, new RegExp(protectedClass), `policy paragraph must name the ${protectedClass} class`);
	}
	assert.match(prompt, /Git-aware tool \(rg\)/);
});

test("latest mode includes the latest prompt and only later ask_user decisions", () => {
	const branch = [
		entry(user("Old unrelated request"), 0),
		entry(askCall("old-q", "Old choice?"), 1),
		entry(askResult("old-q", "Old answer"), 2),
		entry(user("Implement the selected design"), 3),
		entry(askCall("new-q", "Which storage mode?"), 4),
		entry(askResult("new-q", "Project-local"), 5),
	];

	const context = buildParentUserContext("latest", manager(branch));
	assert.match(context ?? "", /Implement the selected design/);
	assert.match(context ?? "", /Question: Which storage mode\?/);
	assert.match(context ?? "", /Answer: Project-local/);
	assert.doesNotMatch(context ?? "", /Old unrelated request|Old answer/);
});

test("all mode includes every user prompt and ask_user decision in the active branch", () => {
	const branch = [
		entry(user("Initial request"), 0),
		entry(askCall("q1", "First decision?"), 1),
		entry(askResult("q1", "Alpha"), 2),
		entry(user([{ type: "text", text: "Follow-up request" }, { type: "image", data: "x" }]), 3),
		entry(askCall("q2", "Second decision?"), 4),
		entry(askResult("q2", "Beta"), 5),
	];

	const context = buildParentUserContext("all", manager(branch));
	assert.match(context ?? "", /Initial request/);
	assert.match(context ?? "", /First decision\?/);
	assert.match(context ?? "", /Answer: Alpha/);
	assert.match(context ?? "", /Follow-up request/);
	assert.match(context ?? "", /\[image attachment omitted\]/);
	assert.match(context ?? "", /Second decision\?/);
	assert.match(context ?? "", /Answer: Beta/);
});

test("cancelled and failed ask_user calls are omitted", () => {
	const cancelled = askResult("cancelled", "", { source: "cancelled", cancelled: true });
	const failed = { ...askResult("failed", "should not appear"), isError: true };
	const branch = [
		entry(user("Request"), 0),
		entry(askCall("cancelled", "Cancelled?"), 1),
		entry(cancelled, 2),
		entry(askCall("failed", "Failed?"), 3),
		entry(failed, 4),
	];

	const context = buildParentUserContext("all", manager(branch));
	assert.equal(context, "[User prompt]\nRequest");
});

test("optional extraction failure does not fail delegation", () => {
	const broken = { getBranch: () => { throw new Error("unavailable"); } } as unknown as ParentSessionManager;
	assert.equal(buildParentUserContext("all", broken), undefined);
});

test("context is bounded and the child prompt clearly delimits it", () => {
	const context = buildParentUserContext("latest", manager([
		entry(user(`start-${"x".repeat(MAX_USER_CONTEXT_CHARS * 2)}-end`), 0),
	]));
	assert.equal(context?.length, MAX_USER_CONTEXT_CHARS);
	assert.match(context ?? "", /^\[User prompt\]\nstart-/);
	assert.match(context ?? "", /context truncated to stay lean/);
	assert.match(context ?? "", /-end$/);

	const prompt = formatSubagentPrompt("review it", context);
	assert.match(prompt, /Traversal safety:/);
	assert.match(prompt, /^Traversal safety:[\s\S]*Task: review it/);
	assert.match(prompt, /<parent_user_context>/);
	assert.match(prompt, /Later recorded clarifications override earlier prompts/);
	assert.match(prompt, /<\/parent_user_context>$/);
});
