import test from "node:test";
import assert from "node:assert/strict";
import {
	MAX_USER_CONTEXT_CHARS,
	buildParentUserContext,
	formatSubagentPrompt,
	type ParentSessionManager,
} from "../user-context.js";

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
	assert.equal(buildParentUserContext(undefined, undefined), undefined);
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
	assert.equal(context?.mode, "latest");
	assert.deepEqual(context?.images, []);
	assert.match(context?.content ?? "", /Implement the selected design/);
	assert.match(context?.content ?? "", /Question: Which storage mode\?/);
	assert.match(context?.content ?? "", /Answer: Project-local/);
	assert.doesNotMatch(context?.content ?? "", /Old unrelated request|Old answer/);
});

test("all mode includes every user prompt and ask_user decision in the active branch", () => {
	const branch = [
		entry(user("Initial request"), 0),
		entry(askCall("q1", "First decision?"), 1),
		entry(askResult("q1", "Alpha"), 2),
		entry(user([{ type: "text", text: "Follow-up request" }, { type: "image", data: "eA==", mimeType: "image/png" }]), 3),
		entry(askCall("q2", "Second decision?"), 4),
		entry(askResult("q2", "Beta"), 5),
	];

	const context = buildParentUserContext("all", manager(branch));
	assert.match(context?.content ?? "", /Initial request/);
	assert.match(context?.content ?? "", /First decision\?/);
	assert.match(context?.content ?? "", /Answer: Alpha/);
	assert.match(context?.content ?? "", /Follow-up request/);
	assert.match(context?.content ?? "", /\[Parent image 1\]/);
	assert.match(context?.content ?? "", /Second decision\?/);
	assert.match(context?.content ?? "", /Answer: Beta/);
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
	assert.equal(context?.content, "[User prompt]\nRequest");
});

test("explicit extraction failure fails delegation", () => {
	const broken = { getBranch: () => { throw new Error("unavailable"); } } as unknown as ParentSessionManager;
	assert.throws(() => buildParentUserContext("all", broken), /parent.*context.*unavailable/i);
	assert.throws(() => buildParentUserContext("latest", undefined), /parent.*context.*unavailable/i);
});

test("context is bounded and the child prompt clearly delimits it", () => {
	const context = buildParentUserContext("latest", manager([
		entry(user(`start-${"x".repeat(MAX_USER_CONTEXT_CHARS * 2)}-end`), 0),
	]));
	assert.equal(context?.content?.length, MAX_USER_CONTEXT_CHARS);
	assert.match(context?.content ?? "", /^\[User prompt\]\nstart-/);
	assert.match(context?.content ?? "", /context truncated to stay lean/);
	assert.match(context?.content ?? "", /-end$/);

	const prompt = formatSubagentPrompt("review it", context?.content);
	assert.match(prompt, /Traversal safety:/);
	assert.match(prompt, /^Traversal safety:[\s\S]*Task: review it/);
	assert.match(prompt, /<parent_user_context>/);
	assert.match(prompt, /Later recorded clarifications override earlier prompts/);
	assert.match(prompt, /<\/parent_user_context>$/);
});

const image = (data = "eA==") => ({ type: "image", data, mimeType: "image/png" });

test("image-only latest context does not fall back to older images", () => {
 const branch = [entry(user([image("eQ==")]), 0), entry(user([image()]), 1)];
 const latest = buildParentUserContext("latest", manager(branch));
 assert.deepEqual(latest?.images, [image()]);
 assert.equal(latest?.content, "[User prompt]\n[Parent image 1]");
 assert.deepEqual(buildParentUserContext("latest", manager([...branch, entry(user("new text"), 2)]))?.images, []);
});

test("all preserves duplicate occurrence order and snapshots payload objects", () => {
 const original = image();
 const context = buildParentUserContext("all", manager([
  entry(user([{ type: "text", text: "before" }, original, { type: "text", text: "between" }, original]), 0),
  entry(user([image("eQ==")]), 1),
  entry({ role: "toolResult", toolName: "other", content: [image()] }, 2),
 ]));
 assert.deepEqual(context?.images, [image(), image(), image("eQ==")]);
 assert.match(context?.content ?? "", /before\n\[Parent image 1\]\nbetween\n\[Parent image 2\]/);
 assert.match(context?.content ?? "", /\[Parent image 3\]/);
 assert.doesNotMatch(context?.content ?? "", /eA==|eQ==/);
 original.data = "changed";
 assert.equal(context?.images[0].data, "eA==");
 assert.notEqual(context?.images[0], context?.images[1]);
});

test("selected malformed image payloads fail without inspecting unselected older images", () => {
 for (const bad of [{ type: "image" }, image(""), image("not base64!"), { ...image(), mimeType: "text/plain" }]) {
  assert.throws(() => buildParentUserContext("all", manager([entry(user([bad]), 0)])), /image/i);
  assert.deepEqual(buildParentUserContext("latest", manager([entry(user([bad]), 0), entry(user("fine"), 1)]))?.images, []);
 }
});

test("image-bearing text is never silently truncated", () => {
 assert.throws(() => buildParentUserContext("all", manager([entry(user([{ type: "text", text: "x".repeat(MAX_USER_CONTEXT_CHARS) }, image()]), 0)])), /latest|narrow/i);
});

test("shared individual and aggregate decoded byte limits are enforced", () => {
 const tenMiB = Buffer.alloc(10 * 1024 * 1024).toString("base64");
 const oversized = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");
 assert.throws(() => buildParentUserContext("all", manager([entry(user([image(oversized)]), 0)])), /10 MiB/);
 assert.equal(buildParentUserContext("all", manager([entry(user([image(tenMiB), image(tenMiB)]), 0)]))?.images.length, 2);
 assert.throws(() => buildParentUserContext("all", manager([entry(user([image(tenMiB), image(tenMiB), image()]), 0)])), /20 MiB/);
});
