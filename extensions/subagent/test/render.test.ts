/**
 * Direct unit tests for the pure render helpers in
 * extensions/subagent/render.ts: truncate, renderDisplayItems, aggregateUsage.
 *
 * render.ts runtime-imports `@mariozechner/pi-tui` (Container/Markdown/Spacer/Text)
 * and `@mariozechner/pi-coding-agent` (getMarkdownTheme), neither of which is
 * resolvable from the repo root under tsx (same reason skill-pruner mocks
 * them). So this file uses the createRequire + Module._resolveFilename mock
 * bootstrap, then requires render.ts. The mocked classes are never invoked by
 * the pure helpers under test — they only need to exist so the module loads.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

installSdkResolverForTests();
const require = createRequire(import.meta.url);
const { truncate, renderDisplayItems, aggregateUsage, renderSubagentCall, renderSubagentResult } = require("../render.ts") as typeof import("../render.js");

function installSdkResolverForTests(): void {
	const mockDir = mkdtempSync(path.join(tmpdir(), "subagent-render-mock-"));
	const sdkPath = path.join(mockDir, "pi-coding-agent.cjs");
	writeFileSync(sdkPath, "exports.getMarkdownTheme = () => ({});\n", "utf-8");
	const tuiPath = path.join(mockDir, "pi-tui.cjs");
	writeFileSync(
		tuiPath,
		[
			// Container records its children so tests can assert the rendered tree
			// structure (child count, types, extracted text) — not just "didn't throw".
			"class Container { constructor(){ this.children = []; } addChild(c){ this.children.push(c); return this; } }",
			"class Markdown { constructor(t,x,y,th){ this.text = t; this.theme = th; } }",
			"class Spacer { constructor(n){ this.n = n; } }",
			"class Text { constructor(t,x,y){ this.text = t; this.x = x; this.y = y; } }",
			"module.exports = { Container, Markdown, Spacer, Text };",
		].join("\n"),
		"utf-8",
	);

	const M = Module as typeof Module & {
		_resolveFilename: (request: string, parent?: unknown, isMain?: boolean, options?: unknown) => string;
	};
	const original = M._resolveFilename;
	M._resolveFilename = function resolveFilename(request, parent, isMain, options): string {
		if (request === "@mariozechner/pi-coding-agent") return sdkPath;
		if (request === "@mariozechner/pi-tui") return tuiPath;
		return original.call(this, request, parent, isMain, options);
	};
}

// Theme stub: wraps text as [color]...[/] so output structure is assertable.
function theme() {
	return {
		fg: (color: string, text: string) => `[${color}]${text}[/]`,
		bold: (t: string) => t,
	};
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

function usage(over: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number; contextTokens: number }> = {}) {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, ...over };
}
function result(over: Partial<{ exitCode: number; usage: ReturnType<typeof usage>; agent: string; task: string; messages: unknown[]; stderr: string }> = {}) {
	return { agent: "worker", agentSource: "user" as const, task: "t", exitCode: 0, messages: [], stderr: "", usage: usage(), ...over };
}

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

test("truncate: no-op when at or under the limit", () => {
	assert.equal(truncate("hello", 5), "hello");
	assert.equal(truncate("hello", 10), "hello");
	assert.equal(truncate("", 5), "");
});

test("truncate: adds ellipsis when over the limit", () => {
	assert.equal(truncate("hello world", 5), "hello...");
	// exactly max+1 -> ellipsis (strictly greater-than)
	assert.equal(truncate("abcdef", 5), "abcde...");
});

test("truncate: ellipsis replaces the tail beyond max (slice(0, max))", () => {
	assert.equal(truncate("abcdefgh", 3), "abc...");
});

// ---------------------------------------------------------------------------
// aggregateUsage
// ---------------------------------------------------------------------------

test("aggregateUsage: empty results -> all zeros", () => {
	assert.deepEqual(aggregateUsage([]), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
});

test("aggregateUsage: sums tokens, cost, and turns across results", () => {
	const total = aggregateUsage([
		result({ usage: usage({ input: 100, output: 50, cost: 0.1, turns: 2, cacheRead: 10, cacheWrite: 5 }) }),
		result({ usage: usage({ input: 200, output: 75, cost: 0.25, turns: 3, cacheRead: 20, cacheWrite: 15 }) }),
	]);
	assert.equal(total.input, 300);
	assert.equal(total.output, 125);
	assert.equal(total.cacheRead, 30);
	assert.equal(total.cacheWrite, 20);
	assert.equal(total.cost, 0.35);
	assert.equal(total.turns, 5);
});

test("aggregateUsage: result shape has only the 6 aggregated fields (no contextTokens)", () => {
	const total = aggregateUsage([result({ usage: usage({ input: 1, contextTokens: 999 }) })]);
	assert.equal(total.input, 1);
	assert.ok(!("contextTokens" in total), "aggregateUsage must not surface contextTokens");
});

// ---------------------------------------------------------------------------
// renderDisplayItems
// ---------------------------------------------------------------------------

test("renderDisplayItems: empty items -> empty string", () => {
	assert.equal(renderDisplayItems([], theme(), false), "");
});

test("renderDisplayItems: text items rendered via toolOutput color", () => {
	const items: DisplayItem[] = [{ type: "text", text: "hello" }];
	const out = renderDisplayItems(items, theme(), false);
	assert.ok(out.includes("[toolOutput]hello"));
});

test("renderDisplayItems: toolCall items rendered with arrow prefix and tool name", () => {
	const items: DisplayItem[] = [{ type: "toolCall", name: "bash", args: { command: "echo hi" } }];
	const out = renderDisplayItems(items, theme(), false);
	assert.ok(out.includes("→"), "arrow prefix present");
	assert.ok(out.includes("$ "), "bash command prompt present");
	assert.ok(out.includes("echo hi"), "command preview present");
	assert.ok(out.includes("[toolOutput]"));
});

test("renderDisplayItems: collapsed (expanded=false) truncates text to first 3 lines", () => {
	const items: DisplayItem[] = [{ type: "text", text: "line1\nline2\nline3\nline4\nline5" }];
	const out = renderDisplayItems(items, theme(), false);
	assert.ok(out.includes("line1"));
	assert.ok(out.includes("line2"));
	assert.ok(out.includes("line3"));
	assert.ok(!out.includes("line4"));
	assert.ok(!out.includes("line5"));
});

test("renderDisplayItems: expanded=true keeps full multi-line text", () => {
	const items: DisplayItem[] = [{ type: "text", text: "line1\nline2\nline3\nline4\nline5" }];
	const out = renderDisplayItems(items, theme(), true);
	assert.ok(out.includes("line5"));
});

test("renderDisplayItems: limit shows last N items with 'earlier items' header", () => {
	const items: DisplayItem[] = Array.from({ length: 5 }, (_, i) => ({ type: "text" as const, text: `t${i}` }));
	const out = renderDisplayItems(items, theme(), false, 2);
	assert.ok(out.includes("... 3 earlier items"), "header notes skipped count");
	assert.ok(out.includes("t3"));
	assert.ok(out.includes("t4"));
	assert.ok(!out.includes("t0"));
	assert.ok(!out.includes("t2"), "t2 is not in the last 2 items");
});

test("renderDisplayItems: limit not exceeded -> no 'earlier items' header", () => {
	const items: DisplayItem[] = [{ type: "text", text: "a" }, { type: "text", text: "b" }];
	const out = renderDisplayItems(items, theme(), false, 5);
	assert.ok(!out.includes("earlier items"));
	assert.ok(out.includes("a"));
	assert.ok(out.includes("b"));
});

// ---------------------------------------------------------------------------
// Tree-inspection helpers for the renderer tests below.
// ---------------------------------------------------------------------------

type RenderNode = { text?: string; children?: RenderNode[]; constructor?: { name?: string } };

function nodeType(node: RenderNode | undefined): string {
	return node?.constructor?.name ?? "";
}

/** Recursively collect every Text/Markdown `.text` from a rendered tree. */
function allText(node: RenderNode | undefined): string {
	if (!node) return "";
	if (typeof node.text === "string") return node.text;
	if (Array.isArray(node.children)) return node.children.map(allText).join("\n");
	return "";
}

function childrenOfType(container: RenderNode | undefined, typeName: string): RenderNode[] {
	return (container?.children ?? []).filter((c) => nodeType(c) === typeName);
}

function assistantMsg(...parts: unknown[]): unknown {
	return { role: "assistant", content: parts, model: "m" };
}
function textPart(t: string): unknown {
	return { type: "text", text: t };
}
function toolCallPart(name: string, args: Record<string, unknown>): unknown {
	return { type: "toolCall", name, arguments: args };
}

/** Flexible SingleResult builder for the renderer tests (covers error/selection fields). */
function sr(over: Record<string, unknown> = {}): SingleResult {
	return {
		agent: "worker",
		agentSource: "user",
		task: "t",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: usage(),
		...over,
	} as SingleResult;
}

type SingleResult = import("../types.js").SingleResult;

function details(mode: "single" | "parallel" | "chain", results: SingleResult[]) {
	return { mode, agentScope: "user" as const, projectAgentsDir: null, results };
}

// ---------------------------------------------------------------------------
// renderSubagentCall (the tool's renderCall)
// ---------------------------------------------------------------------------

test("renderSubagentCall: single mode renders compact one-line title, agent, scope, and task preview", () => {
	const node = renderSubagentCall({ agent: "worker", task: "summarize the code" }, theme(), {});
	assert.equal(nodeType(node), "Text");
	const text = allText(node);
	assert.ok(text.includes("subagent "), "title present");
	assert.ok(text.includes("worker"), "agent name present");
	assert.ok(text.includes("[user]"), "default user scope present");
	assert.ok(text.includes("summarize the code"), "task preview present");
	assert.ok(!text.includes("\n"), "single call is one line");
});

test("renderSubagentCall: respects an explicit agentScope", () => {
	const node = renderSubagentCall({ agent: "scout", task: "x", agentScope: "project" }, theme(), {});
	assert.ok(allText(node).includes("[project]"));
});

test("renderSubagentCall: single with no agent/task shows placeholders", () => {
	const text = allText(renderSubagentCall({}, theme(), {}));
	assert.ok(text.includes("subagent "), "title still present");
	assert.ok(text.includes("..."), "placeholder present for missing agent/task");
});

test("renderSubagentCall: single task truncated at TASK_PREVIEW_LONG (60)", () => {
	const longTask = "x".repeat(70);
	const text = allText(renderSubagentCall({ agent: "worker", task: longTask }, theme(), {}));
	assert.ok(text.includes("..."), "truncation marker present");
	assert.ok(text.includes("x".repeat(60)), "first 60 chars kept");
	assert.ok(!text.includes("x".repeat(61)), "nothing beyond the limit");
});

test("renderSubagentCall: chain renders step count, previews, and strips {previous}", () => {
	const node = renderSubagentCall(
		{ agentScope: "user", chain: [{ agent: "scout", task: "find files" }, { agent: "worker", task: "refine {previous} and ship" }] },
		theme(),
		{},
	);
	const text = allText(node);
	assert.equal(nodeType(node), "Text");
	assert.ok(text.includes("chain (2 steps)"), "chain step count");
	assert.ok(text.includes("scout") && text.includes("worker"), "both agents listed");
	assert.ok(text.includes("find files"), "first task preview");
	assert.ok(text.includes("refine"), "task text after {previous} kept");
	assert.ok(!text.includes("{previous}"), "{previous} placeholder stripped from preview");
});

test("renderSubagentCall: chain > CHAIN_PREVIEW_LIMIT(3) shows '+N more'", () => {
	const chain = Array.from({ length: 5 }, (_, i) => ({ agent: "a", task: `t${i}` }));
	const text = allText(renderSubagentCall({ agentScope: "user", chain }, theme(), {}));
	assert.ok(text.includes("chain (5 steps)"));
	assert.ok(text.includes("+2 more"), "elision hint for the 2 steps beyond the preview limit");
});

test("renderSubagentCall: parallel renders task count and previews", () => {
	const node = renderSubagentCall(
		{ agentScope: "both", tasks: [{ agent: "scout", task: "explore" }, { agent: "worker", task: "build" }] },
		theme(),
		{},
	);
	const text = allText(node);
	assert.ok(text.includes("parallel (2 tasks)"));
	assert.ok(text.includes("scout") && text.includes("build"));
	assert.ok(text.includes("[both]"), "scope rendered");
});

test("renderSubagentCall: parallel > CHAIN_PREVIEW_LIMIT(3) shows '+N more'", () => {
	const tasks = Array.from({ length: 4 }, (_, i) => ({ agent: "a", task: `t${i}` }));
	assert.ok(allText(renderSubagentCall({ agentScope: "user", tasks }, theme(), {})).includes("+1 more"));
});

// ---------------------------------------------------------------------------
// renderSubagentResult (the tool's renderResult)
// ---------------------------------------------------------------------------

test("renderSubagentResult: no details renders the content text", () => {
	const node = renderSubagentResult({ content: [{ type: "text", text: "bare output" }] }, { expanded: false }, theme(), {});
	assert.equal(nodeType(node), "Text");
	assert.equal(allText(node), "bare output");
});

test("renderSubagentResult: no details with non-text content falls back to '(no output)'", () => {
	const node = renderSubagentResult({ content: [{ type: "image" }] }, { expanded: false }, theme(), {});
	assert.equal(allText(node), "(no output)");
});

test("renderSubagentResult: empty results falls through to renderNoDetails", () => {
	const node = renderSubagentResult(
		{ content: [{ type: "text", text: "fallback" }], details: details("single", []) },
		{ expanded: false },
		theme(),
		{},
	);
	assert.equal(allText(node), "fallback");
});

test("renderSubagentResult: single mode with !=1 results hits the final no-details fallback", () => {
	const node = renderSubagentResult(
		{ content: [{ type: "text", text: "raw" }], details: details("single", [sr({ agent: "a" }), sr({ agent: "b" })]) },
		{ expanded: false },
		theme(),
		{},
	);
	assert.equal(allText(node), "raw");
});

test("renderSubagentResult: single expanded success renders compact header/task/output", () => {
	const r1 = sr({ agent: "worker", task: "do thing", messages: [assistantMsg(textPart("final answer"))] });
	const node = renderSubagentResult({ details: details("single", [r1]) }, { expanded: true }, theme(), {});
	assert.equal(nodeType(node), "Container");
	const text = allText(node);
	assert.ok(text.includes("✓"), "success icon");
	assert.ok(text.includes("worker"), "agent in header");
	assert.ok(text.includes("(user)"), "agent source in header");
	assert.ok(text.includes("do thing"), "task text");
	assert.ok(text.includes("final answer"), "final output text");
	assert.ok(childrenOfType(node, "Markdown").length >= 1, "final output rendered as Markdown");
	assert.ok(!text.includes("─── Task ───"), "task section header removed");
	assert.ok(!text.includes("─── Output ───"), "output section header removed");
});

test("renderSubagentResult: single expanded error renders error icon, stopReason, and error message", () => {
	const r1 = sr({ agent: "worker", exitCode: 1, stopReason: "error", errorMessage: "kaboom", messages: [] });
	const node = renderSubagentResult({ details: details("single", [r1]) }, { expanded: true }, theme(), {});
	const text = allText(node);
	assert.ok(text.includes("✗"), "error icon");
	assert.ok(text.includes("[error]"), "stopReason bracket");
	assert.ok(text.includes("Error: kaboom"), "error message line");
	assert.ok(text.includes("(no output)"), "no output marker for empty messages");
});

test("renderSubagentResult: single expanded renders toolCall items via appendToolCalls", () => {
	const r1 = sr({
		agent: "worker",
		task: "t",
		messages: [assistantMsg(toolCallPart("bash", { command: "echo hi" }), textPart("done"))],
	});
	const node = renderSubagentResult({ details: details("single", [r1]) }, { expanded: true }, theme(), {});
	const text = allText(node);
	assert.ok(text.includes("→"), "toolCall arrow prefix");
	assert.ok(text.includes("echo hi"), "bash command preview");
	assert.ok(text.includes("done"), "final output text");
	assert.ok(childrenOfType(node, "Markdown").length >= 1, "final output as Markdown");
});

test("renderSubagentResult: single expanded appends usage and selection info", () => {
	const r1 = sr({
		agent: "worker",
		task: "t",
		messages: [assistantMsg(textPart("ok"))],
		usage: usage({ turns: 2, input: 100, output: 50, cost: 0.1 }),
		model: "claude-x",
		selectedModel: "claude-x",
		selectionPool: ["claude-x", "gpt-y"],
		bucket: "medium",
		thinkingLevel: "low",
	});
	const text = allText(renderSubagentResult({ details: details("single", [r1]) }, { expanded: true }, theme(), {}));
	assert.ok(text.includes("2 turns"), "usage turns");
	assert.ok(text.includes("↑100"), "usage input");
	assert.ok(text.includes("$0.1000"), "usage cost");
	assert.ok(text.includes("🎯"), "selection info prefix");
	assert.ok(text.includes("gpt-y"), "selection pool other candidate");
});

test("renderSubagentResult: single collapsed shows preview and Ctrl+O hint when many items", () => {
	const messages = [assistantMsg(...Array.from({ length: 12 }, (_, i) => textPart(`item ${i}`)))];
	const r1 = sr({ agent: "worker", task: "t", messages });
	const node = renderSubagentResult({ details: details("single", [r1]) }, { expanded: false }, theme(), {});
	assert.equal(nodeType(node), "Text");
	const text = allText(node);
	assert.ok(text.includes("(Ctrl+O to expand)"), "expand hint when items exceed COLLAPSED_ITEM_COUNT");
	assert.ok(text.includes("... 2 earlier items"), "elision header counts skipped items");
	assert.ok(text.includes("item 11"), "last item shown");
	assert.ok(!text.includes("item 0"), "early item hidden by the limit");
});

test("renderSubagentResult: single collapsed error shows error message inline", () => {
	const r1 = sr({ agent: "worker", exitCode: 1, stopReason: "aborted", errorMessage: "user aborted", messages: [] });
	const text = allText(renderSubagentResult({ details: details("single", [r1]) }, { expanded: false }, theme(), {}));
	assert.ok(text.includes("✗"), "error icon");
	assert.ok(text.includes("[aborted]"), "stopReason bracket");
	assert.ok(text.includes("Error: user aborted"), "error message inline");
});

test("renderSubagentResult: single collapsed with no output shows '(no output)'", () => {
	const r1 = sr({ agent: "worker", task: "t", messages: [] });
	const text = allText(renderSubagentResult({ details: details("single", [r1]) }, { expanded: false }, theme(), {}));
	assert.ok(text.includes("✓"), "success icon");
	assert.ok(text.includes("(no output)"), "no output marker");
	assert.ok(!text.includes("(Ctrl+O to expand)"), "no expand hint for empty output");
});

test("renderSubagentResult: single collapsed appends usage and selection info", () => {
	const r1 = sr({
		agent: "worker",
		task: "t",
		messages: [assistantMsg(textPart("hi"))],
		usage: usage({ turns: 1, input: 10, output: 5, cost: 0.01 }),
		model: "m",
		selectedModel: "m",
		selectionPool: ["m"],
		bucket: "small",
	});
	const text = allText(renderSubagentResult({ details: details("single", [r1]) }, { expanded: false }, theme(), {}));
	assert.ok(text.includes("1 turn"), "usage in collapsed view");
	assert.ok(text.includes("↑10"), "usage input in collapsed view");
	assert.ok(text.includes("🎯"), "selection info in collapsed view");
});

test("renderSubagentResult: chain expanded renders compact header, each step, and total", () => {
	const r1 = sr({ agent: "scout", task: "find", step: 1, messages: [assistantMsg(textPart("found"))], usage: usage({ input: 10, output: 5, cost: 0.01 }) });
	const r2 = sr({ agent: "worker", task: "build", step: 2, messages: [assistantMsg(textPart("built"))], usage: usage({ input: 20, output: 10, cost: 0.02 }) });
	const node = renderSubagentResult({ details: details("chain", [r1, r2]) }, { expanded: true }, theme(), {});
	assert.equal(nodeType(node), "Container");
	const text = allText(node);
	assert.ok(text.includes("chain "), "chain header");
	assert.ok(text.includes("2/2 steps"), "all-success step count");
	assert.ok(text.includes("found") && text.includes("built"), "step outputs");
	assert.ok(text.includes("Total:"), "chain total");
	// Each step header is its own Text child; verify step index maps to the right agent.
	const stepTexts = childrenOfType(node, "Text").map((c) => c.text ?? "");
	const step1 = stepTexts.find((t) => t.includes("1."));
	const step2 = stepTexts.find((t) => t.includes("2."));
	assert.ok(step1 && step1.includes("scout"), "step 1 header names scout");
	assert.ok(step2 && step2.includes("worker"), "step 2 header names worker");
	assert.ok(!text.includes("─── Step"), "old step divider removed");
});

test("renderSubagentResult: chain collapsed shows summary, total, and expand hint", () => {
	const r1 = sr({ agent: "scout", task: "find", step: 1, messages: [assistantMsg(textPart("found"))], usage: usage({ input: 10, output: 5, cost: 0.01 }) });
	const r2 = sr({ agent: "worker", task: "build", step: 2, messages: [assistantMsg(textPart("built"))], usage: usage({ input: 20, output: 10, cost: 0.02 }) });
	const node = renderSubagentResult({ details: details("chain", [r1, r2]) }, { expanded: false }, theme(), {});
	assert.equal(nodeType(node), "Text");
	const text = allText(node);
	assert.ok(text.includes("2/2 steps"));
	assert.ok(text.includes("Total:"));
	assert.ok(text.includes("(Ctrl+O to expand)"));
});

test("renderSubagentResult: chain with a failed step shows error icon and partial count", () => {
	const r1 = sr({ agent: "scout", task: "find", step: 1, messages: [assistantMsg(textPart("found"))] });
	const r2 = sr({ agent: "worker", task: "build", step: 2, exitCode: 1, stopReason: "error", errorMessage: "nope", messages: [] });
	const text = allText(renderSubagentResult({ details: details("chain", [r1, r2]) }, { expanded: false }, theme(), {}));
	assert.ok(text.includes("✗"), "chain error icon");
	assert.ok(text.includes("1/2 steps"), "one success of two");
	assert.ok(text.includes("(no output)"), "failed step with empty messages shows no-output");
});

test("renderSubagentResult: parallel expanded renders header, steps, and total", () => {
	const r1 = sr({ agent: "scout", task: "explore", messages: [assistantMsg(textPart("explored"))], usage: usage({ input: 10, output: 5, cost: 0.01 }) });
	const r2 = sr({ agent: "worker", task: "build", messages: [assistantMsg(textPart("built"))], usage: usage({ input: 20, output: 10, cost: 0.02 }) });
	const node = renderSubagentResult({ details: details("parallel", [r1, r2]) }, { expanded: true }, theme(), {});
	assert.equal(nodeType(node), "Container");
	const text = allText(node);
	assert.ok(text.includes("parallel "));
	assert.ok(text.includes("2/2 tasks"), "all-done status");
	assert.ok(text.includes("Total:"));
});

test("renderSubagentResult: parallel collapsed shows summary and expand hint", () => {
	const r1 = sr({ agent: "scout", task: "explore", messages: [assistantMsg(textPart("explored"))] });
	const node = renderSubagentResult({ details: details("parallel", [r1]) }, { expanded: false }, theme(), {});
	assert.equal(nodeType(node), "Text");
	const text = allText(node);
	assert.ok(text.includes("1/1 tasks"));
	assert.ok(text.includes("(Ctrl+O to expand)"));
});

test("renderSubagentResult: parallel with a running task shows running icon and stays collapsed", () => {
	const r1 = sr({ agent: "scout", task: "explore", messages: [assistantMsg(textPart("done"))] });
	const r2 = sr({ agent: "worker", task: "build", exitCode: -1, messages: [] }); // still running
	// expanded=true but isRunning -> must take the collapsed path
	const node = renderSubagentResult({ details: details("parallel", [r1, r2]) }, { expanded: true }, theme(), {});
	assert.equal(nodeType(node), "Text", "running forces collapsed even when expanded");
	const text = allText(node);
	assert.ok(text.includes("⏳"), "running icon");
	assert.ok(text.includes("running"), "running status text");
	assert.ok(text.includes("(running...)"), "running step marker");
	assert.ok(!text.includes("Total:"), "no total while still running");
	assert.ok(!text.includes("(Ctrl+O to expand)"), "no expand hint while running (expanded=true)");
});

test("renderSubagentResult: parallel running collapsed hides expand hint", () => {
	const r1 = sr({ agent: "scout", task: "explore", exitCode: -1, messages: [] });
	const node = renderSubagentResult({ details: details("parallel", [r1]) }, { expanded: false }, theme(), {});
	const text = allText(node);
	assert.ok(text.includes("⏳"), "running icon");
	assert.ok(!text.includes("(Ctrl+O to expand)"), "no expand hint while running");
});

test("renderSubagentResult: parallel partial stays collapsed", () => {
	const r1 = sr({ agent: "scout", task: "explore", exitCode: -1, messages: [] });
	const r2 = sr({ agent: "worker", task: "build", exitCode: -1, messages: [] });
	const node = renderSubagentResult({ details: details("parallel", [r1, r2]) }, { expanded: true, isPartial: true }, theme(), {});
	assert.equal(nodeType(node), "Text", "partial parallel renders collapsed Text");
	const text = allText(node);
	assert.ok(text.includes("⏳"), "running indicator");
	assert.ok(text.includes("running"), "running status text");
	assert.ok(!text.includes("(Ctrl+O to expand)"), "no expand hint while partial");
});

test("renderSubagentResult: parallel mixed success/fail (no running) shows partial icon", () => {
	const r1 = sr({ agent: "scout", task: "explore", messages: [assistantMsg(textPart("ok"))], usage: usage({ input: 10, output: 5, cost: 0.01 }) });
	const r2 = sr({ agent: "worker", task: "build", exitCode: 1, stopReason: "error", errorMessage: "boom", messages: [], usage: usage({ input: 5 }) });
	const text = allText(renderSubagentResult({ details: details("parallel", [r1, r2]) }, { expanded: false }, theme(), {}));
	assert.ok(text.includes("◐"), "partial-failure warning icon");
	assert.ok(text.includes("1/2 tasks"), "one success of two");
	assert.ok(text.includes("Total:"), "total shown when not running");
});

// ---------------------------------------------------------------------------
// Compact running / partial rendering
// ---------------------------------------------------------------------------

test("renderSubagentResult: single partial stays collapsed with running indicator", () => {
	const r1 = sr({ agent: "worker", task: "do thing", exitCode: -1, messages: [] });
	const node = renderSubagentResult({ details: details("single", [r1]) }, { expanded: true, isPartial: true }, theme(), {});
	assert.equal(nodeType(node), "Text", "partial single renders collapsed Text");
	const text = allText(node);
	assert.ok(text.includes("⏳"), "running indicator");
	assert.ok(text.includes("running..."), "running status text");
	assert.ok(text.includes("do thing"), "task still visible");
	assert.ok(!text.includes("─── Task ───"), "no expanded section headers");
	assert.ok(!text.includes("(Ctrl+O to expand)"), "no expand hint while running");
});

test("renderSubagentResult: chain partial stays collapsed with running indicator", () => {
	const r1 = sr({ agent: "scout", task: "find", step: 1, exitCode: -1, messages: [] });
	const r2 = sr({ agent: "worker", task: "build", step: 2, exitCode: -1, messages: [] });
	const node = renderSubagentResult({ details: details("chain", [r1, r2]) }, { expanded: true, isPartial: true }, theme(), {});
	assert.equal(nodeType(node), "Text", "partial chain renders collapsed Text");
	const text = allText(node);
	assert.ok(text.includes("⏳"), "running indicator");
	assert.ok(text.includes("2 steps, 2 running"), "running status text");
	assert.ok(text.includes("1."), "step 1 shown");
	assert.ok(text.includes("scout"), "step 1 agent shown");
	assert.ok(text.includes("2."), "step 2 shown");
	assert.ok(text.includes("worker"), "step 2 agent shown");
	assert.ok(!text.includes("Total:"), "no total while running");
	assert.ok(!text.includes("(Ctrl+O to expand)"), "no expand hint while running");
});

test("renderSubagentResult: single collapsed running result shows running indicator", () => {
	const r1 = sr({ agent: "worker", task: "t", exitCode: -1, messages: [] });
	const text = allText(renderSubagentResult({ details: details("single", [r1]) }, { expanded: false }, theme(), {}));
	assert.ok(text.includes("⏳"), "running indicator");
	assert.ok(text.includes("running..."), "running status text");
	assert.ok(!text.includes("(no output)"), "no output marker not shown while running");
});

test("renderSubagentResult: running result explains provider wait and stall budget", () => {
	const r1 = sr({
		agent: "scout",
		task: "audit",
		exitCode: -1,
		messages: [],
		activityPhase: "waiting_provider",
		activityDetail: "waiting for provider response",
		activitySince: Date.now() - 12_000,
		inactivityBudgetMs: 300_000,
	});
	const text = allText(renderSubagentResult({ details: details("single", [r1]) }, { expanded: false }, theme(), {}));
	assert.ok(text.includes("waiting for provider"));
	assert.ok(text.includes("waiting for provider response"));
	assert.ok(text.includes("stall limit 5m 0s"));
});
