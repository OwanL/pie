import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { withCopilotHeaders, withCopilotOptions } from "../copilot-headers.js";

installSdkResolverForTests();
const require = createRequire(import.meta.url);
const { __ensureCopilotHeaders, __COPILOT_IDE_HEADERS } = require("../../../../extensions/skill-pruner/index.ts") as typeof import("../../../../extensions/skill-pruner/index.js");

function installSdkResolverForTests(): void {
	const mockDir = mkdtempSync(path.join(tmpdir(), "skill-pruner-sdk-mock-"));

	const sdkPath = path.join(mockDir, "pi-coding-agent.cjs");
	writeFileSync(sdkPath, "exports.formatSkillsForPrompt = () => { throw new Error('test must call __setFormatter'); };\n", "utf-8");

	const tuiPath = path.join(mockDir, "pi-tui.cjs");
	writeFileSync(tuiPath, [
		"class Box {",
		"  children = [];",
		"  constructor(px, py, bgFn) { this.paddingX = px; this.paddingY = py; this.bgFn = bgFn; }",
		"  addChild(c) { this.children.push(c); }",
		"  render(w) { return this.children.flatMap(c => c.render(w)); }",
		"}",
		"class Text {",
		"  constructor(text, px, py) { this.text = text; this.paddingX = px; this.paddingY = py; }",
		"  render(w) { return [this.text]; }",
		"}",
		"module.exports = { Box, Text };",
	].join("\n"), "utf-8");

	const moduleWithResolver = Module as typeof Module & {
		_resolveFilename: (request: string, parent?: unknown, isMain?: boolean, options?: unknown) => string;
	};
	const originalResolveFilename = moduleWithResolver._resolveFilename;
	moduleWithResolver._resolveFilename = function resolveFilename(request, parent, isMain, options): string {
		if (request === "@earendil-works/pi-coding-agent") {
			return sdkPath;
		}
		if (request === "@earendil-works/pi-tui") {
			return tuiPath;
		}
		return originalResolveFilename.call(this, request, parent, isMain, options);
	};
}

const COPILOT_KEYS = Object.keys(__COPILOT_IDE_HEADERS);

test("ensureCopilotHeaders: non-copilot model returned unchanged", () => {
	const model = { id: "gpt-4o", provider: "openai", headers: { "x-custom": "yes" } };
	const result = __ensureCopilotHeaders(model);
	assert.deepEqual(result, model);
});

test("ensureCopilotHeaders: copilot model with full headers returned unchanged", () => {
	const model = {
		id: "gpt-5-mini",
		provider: "github-copilot",
		headers: { ...__COPILOT_IDE_HEADERS },
	};
	const result = __ensureCopilotHeaders(model);
	assert.deepEqual(result, model);
});

test("ensureCopilotHeaders: copilot model with headers=undefined gets patched", () => {
	const model = {
		id: "gpt-5-mini",
		provider: "github-copilot",
		headers: undefined,
	};
	const result = __ensureCopilotHeaders(model) as Record<string, unknown>;
	assert.ok(result.headers, "headers should be defined after patching");
	const patchedHeaders = result.headers as Record<string, string>;
	for (const key of COPILOT_KEYS) {
		assert.ok(patchedHeaders[key], `missing header: ${key}`);
		assert.equal(patchedHeaders[key], __COPILOT_IDE_HEADERS[key as keyof typeof __COPILOT_IDE_HEADERS], `wrong value for ${key}`);
	}
});

test("ensureCopilotHeaders: copilot model with empty headers gets all copilot keys", () => {
	const model = {
		id: "gpt-5-mini",
		provider: "github-copilot",
		headers: {},
	};
	const result = __ensureCopilotHeaders(model) as Record<string, unknown>;
	const patchedHeaders = result.headers as Record<string, string>;
	assert.equal(Object.keys(patchedHeaders).length, COPILOT_KEYS.length);
	for (const key of COPILOT_KEYS) {
		assert.equal(patchedHeaders[key], __COPILOT_IDE_HEADERS[key as keyof typeof __COPILOT_IDE_HEADERS]);
	}
});

test("ensureCopilotHeaders: copilot model with partial headers — only missing keys added", () => {
	const model = {
		id: "gpt-5-mini",
		provider: "github-copilot",
		headers: { "Editor-Version": "vscode/1.99.0" },
	};
	const result = __ensureCopilotHeaders(model) as Record<string, unknown>;
	const patchedHeaders = result.headers as Record<string, string>;
	// Existing Editor-Version is NOT overridden
	assert.equal(patchedHeaders["Editor-Version"], "vscode/1.99.0");
	// Other copilot keys are added
	for (const key of COPILOT_KEYS) {
		if (key === "Editor-Version") continue;
		assert.equal(patchedHeaders[key], __COPILOT_IDE_HEADERS[key as keyof typeof __COPILOT_IDE_HEADERS]);
	}
});

test("ensureCopilotHeaders: copilot model with empty headers — returns new object", () => {
	const model = {
		id: "gpt-5-mini",
		provider: "github-copilot",
		headers: {},
	};
	const result = __ensureCopilotHeaders(model);
	assert.notEqual(result, model, "should return a new object when patching");
});

test("ensureCopilotHeaders: copilot model with all headers — returns same object", () => {
	const model = {
		id: "gpt-5-mini",
		provider: "github-copilot",
		headers: { ...__COPILOT_IDE_HEADERS },
	};
	const result = __ensureCopilotHeaders(model);
	assert.equal(result, model, "should return the same object when no patching needed");
});

test("COPILOT_IDE_HEADERS includes Editor-Version", () => {
	assert.ok(__COPILOT_IDE_HEADERS["Editor-Version"], "Editor-Version must be present");
	assert.ok(__COPILOT_IDE_HEADERS["Editor-Version"].startsWith("vscode/"), "Editor-Version should start with vscode/");
});

test("withCopilotHeaders preserves existing headers and adds missing keys", () => {
	const headers = { "Editor-Version": "vscode/custom", "x-custom": "yes" };
	const result = withCopilotHeaders(headers, true);
	assert.notEqual(result, headers);
	assert.equal(result?.["Editor-Version"], "vscode/custom");
	assert.equal(result?.["x-custom"], "yes");
	for (const key of COPILOT_KEYS) {
		if (key === "Editor-Version") continue;
		assert.equal(result?.[key], __COPILOT_IDE_HEADERS[key as keyof typeof __COPILOT_IDE_HEADERS]);
	}
});

test("withCopilotHeaders leaves non-Copilot headers unchanged", () => {
	const headers = { "x-custom": "yes" };
	assert.equal(withCopilotHeaders(headers, false), headers);
});

test("withCopilotOptions leaves non-Copilot options unchanged", () => {
	const options = { headers: { "x-custom": "yes" } };
	assert.equal(withCopilotOptions(options, { provider: "openai" }), options);
});

test("withCopilotOptions patches Copilot options while preserving existing headers", () => {
	const options = { headers: { "Editor-Version": "vscode/custom", "x-custom": "yes" } };
	const result = withCopilotOptions(options, { provider: "github-copilot" }) as typeof options;
	assert.notEqual(result, options);
	assert.equal(result.headers["Editor-Version"], "vscode/custom");
	assert.equal(result.headers["x-custom"], "yes");
	for (const key of COPILOT_KEYS) {
		if (key === "Editor-Version") continue;
		assert.equal(result.headers[key], __COPILOT_IDE_HEADERS[key as keyof typeof __COPILOT_IDE_HEADERS]);
	}
});

test("withCopilotOptions returns existing options when all Copilot keys are present", () => {
	const options = { headers: { ...__COPILOT_IDE_HEADERS } };
	assert.equal(withCopilotOptions(options, { provider: "github-copilot" }), options);
});