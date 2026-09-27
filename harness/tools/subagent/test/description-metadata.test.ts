/**
 * Guard-rail tests for the subagent tool's prompt-facing description.
 *
 * The tool description is the only always-on guidance the model sees for the
 * subagent surface (promptGuidelines cover only orchestration ordering), so it
 * must keep the two clarifications that prevent recurring misuse:
 *   - context isolation is NOT sandboxing (children share the parent process,
 *     filesystem, and credentials);
 *   - agent discovery includes project agents under an explicitly provided cwd.
 *
 * register.ts runtime-imports the pi SDK transitively (render.ts →
 * `@mariozechner/pi-coding-agent` / `@mariozechner/pi-tui`), neither of which
 * is resolvable from the repo root under tsx (same reason render.test.ts mocks
 * them). This file uses the same createRequire + Module._resolveFilename mock
 * bootstrap, then requires register.ts. The mocked classes are never invoked —
 * they only need to exist so the module loads.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const restoreSdkResolver = installSdkResolverForTests();
const require = createRequire(import.meta.url);
let registerSubagent: (pi: unknown) => void;
try {
	registerSubagent = require("../register.ts").default;
} finally {
	restoreSdkResolver();
}

function installSdkResolverForTests(): () => void {
	const mockDir = mkdtempSync(path.join(tmpdir(), "subagent-register-mock-"));
	const sdkPath = path.join(mockDir, "pi-coding-agent.cjs");
	writeFileSync(sdkPath, "exports.getMarkdownTheme = () => ({});\n", "utf-8");
	const tuiPath = path.join(mockDir, "pi-tui.cjs");
	writeFileSync(tuiPath, "exports.Container = class {}; exports.Markdown = class {}; exports.Spacer = class {}; exports.Text = class {};\n", "utf-8");

	// Copy of render.test.ts's resolver hook: redirect the legacy SDK names to
	// the mock modules so register.ts (and its transitive render import) loads
	// under plain tsx.
	const originalResolve = (Module as unknown as { _resolveFilename: Function })._resolveFilename;
	(Module as unknown as { _resolveFilename: Function })._resolveFilename = function patched(
		request: string, ...rest: unknown[]
	): string {
		if (request === "@mariozechner/pi-coding-agent") request = sdkPath;
		if (request === "@mariozechner/pi-tui") request = tuiPath;
		return originalResolve.call(this, request, ...rest);
	};
	return () => {
		(Module as unknown as { _resolveFilename: Function })._resolveFilename = originalResolve;
		rmSync(mockDir, { recursive: true, force: true });
	};
}

test("subagent tool guidance encourages bounded parallel work while preserving isolation and ordering safeguards", () => {
	type PromptMetadata = { description: string; promptSnippet: string; promptGuidelines: string[] };
	let def: PromptMetadata | undefined;
	registerSubagent({
		on: () => undefined,
		getFlag: () => undefined,
		getThinkingLevel: () => undefined,
		registerFlag: () => undefined,
		registerTool: (definition: PromptMetadata) => {
			def = definition;
		},
	});
	assert.ok(def, "registerTool must capture the tool definition");

	assert.match(def!.description, /not sandboxing/);
	assert.match(def!.description, /process, filesystem, and credentials/);
	assert.match(def!.description, /project agents under an explicitly provided cwd/);
	assert.match(def!.promptSnippet, /small, bounded task/);
	assert.match(def!.promptSnippet, /prefer parallel sibling calls for independent tasks/);
	const guidance = def!.promptGuidelines.join(" ");
	assert.match(guidance, /Proactively dispatch independent, small subagent tasks together as sibling calls in one response/);
	assert.match(guidance, /non-overlapping edit ownership/);
	assert.match(guidance, /wait for prior results when tasks depend on them/);
	assert.match(guidance, /serialize work that would conflict over shared files or resources/);
});