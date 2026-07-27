import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import {
	formatTokens,
	formatUsageStats,
	formatToolCall,
	getFinalOutput,
	getDisplayItems,
	formatSelectionInfo,
} from "../formatting.js";
import type { Message } from "@mariozechner/pi-ai";
import type { DisplayItem } from "../types.js";

// Minimal theme stub — returns "color:text" so assertions can check structure
const fg = (_color: any, text: string) => `<${_color}>${text}</${_color}>`;

// --- formatTokens ---

test("formatTokens: under 1000 returns raw number", () => {
	assert.equal(formatTokens(42), "42");
	assert.equal(formatTokens(999), "999");
});

test("formatTokens: 1k-9.9k returns one decimal", () => {
	assert.equal(formatTokens(1000), "1.0k");
	assert.equal(formatTokens(9900), "9.9k");
});

test("formatTokens: 10k-999k rounds to whole k", () => {
	assert.equal(formatTokens(10000), "10k");
	assert.equal(formatTokens(500000), "500k");
});

test("formatTokens: 1M+ returns one decimal M", () => {
	assert.equal(formatTokens(1000000), "1.0M");
	assert.equal(formatTokens(2500000), "2.5M");
});

// --- formatUsageStats ---

test("formatUsageStats: empty usage returns empty string", () => {
	assert.equal(formatUsageStats({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }), "");
});

test("formatUsageStats: includes turns, tokens, cost, model", () => {
	const result = formatUsageStats(
		{ input: 5000, output: 1000, cacheRead: 0, cacheWrite: 0, cost: 0.0123, turns: 3, contextTokens: 8000 },
		"test-model",
	);
	assert.match(result, /3 turns/);
	assert.match(result, /↑5\.0k/);
	assert.match(result, /↓1\.0k/);
	assert.match(result, /\$0\.0123/);
	assert.match(result, /ctx:8\.0k/);
	assert.match(result, /test-model/);
});

test("formatUsageStats: includes cache stats when present", () => {
	const result = formatUsageStats(
		{ input: 0, output: 0, cacheRead: 2000, cacheWrite: 500, cost: 0 },
	);
	assert.match(result, /R2\.0k/);
	assert.match(result, /W500/);
});

test("formatUsageStats: uses singular turn label and skips non-positive context", () => {
	const result = formatUsageStats(
		{ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, contextTokens: 0 },
	);
	assert.match(result, /1 turn/);
	assert.doesNotMatch(result, /1 turns/);
	assert.doesNotMatch(result, /ctx:/);
});

// --- getFinalOutput ---

test("getFinalOutput returns last assistant text", () => {
	const messages: Message[] = [
		{ role: "assistant", content: [{ type: "text", text: "first" }], model: "m" },
		{ role: "user", content: [{ type: "text", text: "user msg" }], model: "m" },
		{ role: "assistant", content: [{ type: "text", text: "final answer" }], model: "m" },
	];
	assert.equal(getFinalOutput(messages), "final answer");
});

test("getFinalOutput returns empty string for no assistant messages", () => {
	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: "hello" }], model: "m" },
	];
	assert.equal(getFinalOutput(messages), "");
});

test("getFinalOutput returns empty string for empty array", () => {
	assert.equal(getFinalOutput([]), "");
});

test("getFinalOutput skips tool-call-only assistant messages", () => {
	const messages: Message[] = [
		{
			role: "assistant",
			content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }],
			model: "m",
		},
	];
	assert.equal(getFinalOutput(messages), "");
});

test("getFinalOutput scans backward to earlier assistant text when latest has none", () => {
	const messages: Message[] = [
		{ role: "assistant", content: [{ type: "text", text: "earlier answer" }], model: "m" },
		{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a" } }], model: "m" },
	];
	assert.equal(getFinalOutput(messages), "earlier answer");
});

// --- getDisplayItems ---

test("getDisplayItems extracts text and tool calls from assistant messages", () => {
	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: "user msg" }], model: "m" },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "thinking..." },
				{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
				{ type: "text", text: "done" },
			],
			model: "m",
		},
	];
	const items = getDisplayItems(messages);
	assert.equal(items.length, 3);
	assert.equal(items[0].type, "text");
	assert.equal((items[0] as any).text, "thinking...");
	assert.equal(items[1].type, "toolCall");
	assert.equal((items[1] as any).name, "bash");
	assert.equal(items[2].type, "text");
	assert.equal((items[2] as any).text, "done");
});

test("getDisplayItems skips user messages", () => {
	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: "skip me" }], model: "m" },
		{ role: "assistant", content: [{ type: "text", text: "keep me" }], model: "m" },
	];
	const items = getDisplayItems(messages);
	assert.equal(items.length, 1);
	assert.equal((items[0] as any).text, "keep me");
});

// --- formatToolCall ---

test("formatToolCall: bash shows command preview", () => {
	const result = formatToolCall("bash", { command: "echo hello" }, fg);
	assert.match(result, /\$ /);
	assert.match(result, /echo hello/);
});

test("formatToolCall: bash truncates long commands", () => {
	const longCmd = "a".repeat(100);
	const result = formatToolCall("bash", { command: longCmd }, fg);
	// Preview is 60 chars + "..."
	assert.match(result, /aaa\.\.\./);
});

test("formatToolCall: read shows file path", () => {
	const result = formatToolCall("read", { file_path: "/tmp/test.ts" }, fg);
	assert.match(result, /read/);
	assert.match(result, /test\.ts/);
});

test("formatToolCall: read shows offset/limit range", () => {
	const result = formatToolCall("read", { file_path: "/tmp/test.ts", offset: 10, limit: 5 }, fg);
	assert.match(result, /10-14/);
});

test("formatToolCall: write shows file path and line count", () => {
	const result = formatToolCall(
		"write",
		{ file_path: "/tmp/test.ts", content: "line1\nline2\nline3" },
		fg,
	);
	assert.match(result, /write/);
	assert.match(result, /3 lines/);
});

test("formatToolCall: edit shows file path", () => {
	const result = formatToolCall("edit", { file_path: "/tmp/test.ts" }, fg);
	assert.match(result, /edit/);
	assert.match(result, /test\.ts/);
});

test("formatToolCall: unknown tool shows JSON args", () => {
	const result = formatToolCall("custom-tool", { foo: "bar" }, fg);
	assert.match(result, /custom-tool/);
	assert.match(result, /foo/);
});

test("formatToolCall: supports ls/find/grep helpers", () => {
	assert.match(formatToolCall("ls", { path: "/tmp" }, fg), /ls/);
	assert.match(formatToolCall("find", { pattern: "*.ts", path: "/repo" }, fg), /\*\.ts/);
	assert.match(formatToolCall("grep", { pattern: "TODO", path: "/repo" }, fg), /\/TODO\//);
});

test("formatToolCall: shortens home paths and handles read limit without offset", () => {
	const home = os.homedir();
	const target = `${home}/project/file.ts`;

	const readResult = formatToolCall("read", { path: target, limit: 3 }, fg);
	assert.match(readResult, /~\//);
	assert.match(readResult, /:1-3/);

	const writeResult = formatToolCall("write", { path: target, content: "single line" }, fg);
	assert.match(writeResult, /~\//);
	assert.doesNotMatch(writeResult, /lines\)/);
});

test("formatToolCall: unknown tool truncates very long argument previews", () => {
	const result = formatToolCall("custom-tool", { payload: "x".repeat(200) }, fg);
	assert.match(result, /\.\.\./);
});

test("formatToolCall: uses fallback defaults when arguments are omitted", () => {
	assert.match(formatToolCall("bash", {}, fg), /\.\.\./);
	assert.match(formatToolCall("read", {}, fg), /\.\.\./);
	assert.match(formatToolCall("ls", {}, fg), /\./);
	assert.match(formatToolCall("find", {}, fg), /\*/);
	assert.match(formatToolCall("grep", {}, fg), /\/\//);
});

test("formatToolCall: supports path-only edit/read variants", () => {
	const editResult = formatToolCall("edit", { path: "/tmp/file.ts" }, fg);
	assert.match(editResult, /file\.ts/);

	const readOffsetOnly = formatToolCall("read", { path: "/tmp/file.ts", offset: 7 }, fg);
	assert.match(readOffsetOnly, /:7/);
	assert.doesNotMatch(readOffsetOnly, /-\d+/);
});

// --- formatSelectionInfo ---

test("formatSelectionInfo returns undefined when no bucket or model", () => {
	assert.equal(formatSelectionInfo({}, fg), undefined);
});

test("formatSelectionInfo shows bucket hint", () => {
	const result = formatSelectionInfo(
		{ bucket: "medium" },
		fg,
	);
	assert.ok(result);
	assert.match(result!, /medium/);
});

test("formatSelectionInfo shows selected model with pool", () => {
	const result = formatSelectionInfo(
		{
			bucket: "medium",
			selectedModel: "model-a",
			selectionPool: ["model-a", "model-b"],
		},
		fg,
	);
	assert.ok(result);
	assert.match(result!, /model-a/);
	assert.match(result!, /model-b/);
});

test("formatSelectionInfo shows thinking level", () => {
	const result = formatSelectionInfo(
		{ bucket: "medium", thinkingLevel: "high" },
		fg,
	);
	assert.ok(result);
	assert.match(result!, /high/);
});

test("formatSelectionInfo shows fallback info when model failed and was retried", () => {
	const result = formatSelectionInfo(
		{
			bucket: "medium",
			selectedModel: "model-b",
			selectionPool: ["model-b", "model-c"],
			failedModel: "model-a",
			retryCount: 1,
		},
		fg,
	);
	assert.ok(result);
	assert.match(result!, /fallback #1/);
	assert.match(result!, /skipped model-a/);
});

test("formatSelectionInfo hides fallback info when no failed model", () => {
	const result = formatSelectionInfo(
		{
			bucket: "medium",
			selectedModel: "model-b",
			selectionPool: ["model-b"],
		},
		fg,
	);
	assert.ok(result);
	assert.ok(!result!.includes("fallback"));
});

test("formatSelectionInfo handles fallback flag and includes diagnostics", () => {
	const result = formatSelectionInfo(
		{
			selectedModel: "model-a:cloud",
			selectionPool: ["model-a:cloud", "model-b:local"],
			fallback: true,
			failedModel: "model-z:cloud",
			retryCount: 2,
			modelResolutionDiagnostic: "model override not found",
		},
		fg,
	);
	assert.ok(result);
	assert.match(result!, /model-a/);
	assert.match(result!, /fallback/);
	assert.match(result!, /\| model-b/);
	assert.match(result!, /fallback #2/);
	assert.match(result!, /model override not found/);
});

test("formatSelectionInfo surfaces the nested-bucket downgrade reason", () => {
	const result = formatSelectionInfo(
		{
			bucket: "medium",
			selectedModel: "sonnet",
			selectionPool: ["sonnet"],
			bucketDowngradeReason: 'Nested subagent (depth 1) requested bucket "frontier" but it is not allowed for nested subagents; downgraded to "medium".',
		},
		fg,
	);
	assert.ok(result);
	assert.match(result!, /⚠/);
	assert.match(result!, /downgraded to "medium"/);
});

test("formatSelectionInfo returns undefined when no bucket and no model", () => {
	assert.equal(formatSelectionInfo({}, fg), undefined);
});

test("formatSelectionInfo handles selected model missing from pool", () => {
	const result = formatSelectionInfo(
		{
			selectedModel: "chosen:local",
			selectionPool: ["other:cloud"],
		},
		fg,
	);
	assert.ok(result);
	assert.match(result!, /chosen/);
});

test("formatSelectionInfo surfaces a satisfied requirement as provenance", () => {
	const result = formatSelectionInfo(
		{
			bucket: "medium",
			selectedModel: "image-model",
			selectionPool: ["image-model"],
			requestedModelRequirements: { inputKinds: ["image"] },
			modelRequirementsSatisfied: true,
		},
		fg,
	);
	assert.ok(result);
	assert.match(result!, /req:image/);
});

test("formatSelectionInfo surfaces the requirement diagnostic when selection failed", () => {
	const result = formatSelectionInfo(
		{
			requestedModelRequirements: { inputKinds: ["image"] },
			modelRequirementsSatisfied: false,
			requirementDiagnostic: 'No enabled image-capable model is available for the requested "medium" subagent bucket.',
		},
		fg,
	);
	assert.ok(result);
	assert.match(result!, /⚠/);
	assert.match(result!, /No enabled image-capable model/);
	assert.match(result!, /req:image/);
});

test("formatSelectionInfo returns undefined when only an absent requirement is present", () => {
	// No bucket/model and no active requirement → undefined (unchanged behaviour).
	assert.equal(formatSelectionInfo({}, fg), undefined);
});