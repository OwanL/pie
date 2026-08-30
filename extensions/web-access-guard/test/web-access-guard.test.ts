/**
 * Tests for the web-access-guard extension.
 *
 * Covers the pure rewrite/strip helpers and the filesystem patch+repair logic
 * against a real temp-dir "package" (no SDK, no LLM, no network). The lookup
 * (`resolvePackageRoot`) is exercised through its injectable
 * `PackageRootLookupDeps` (fake managed-root probes, real temp dirs), and
 * `runSelfHeal` through its injectable resolver — the unparameterized default
 * factory is the only untested glue.
 *
 * Includes a 0.27.0 source-shape section whose fixtures are literal excerpts
 * from the published `pi-web-access@0.27.0` tarball, so a regression in the
 * workflow-policy patch regexes fails here instead of silently no-oping
 * against a real install.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyWebAccessGuard,
	isDeleteArtifact,
	patchWorkflowClampFiles,
	patchWorkflowClampInSource,
	patchWorkflowDescriptionFiles,
	patchWorkflowDescriptionInSource,
	readabilityIntact,
	repairDeleteArtifacts,
	resolvePackageRoot,
	runSelfHeal,
	stripDeleteSuffix,
	type PackageRootLookupDeps,
} from "../index.js";

function makePkg() {
	const root = mkdtempSync(path.join(os.tmpdir(), "wag-"));
	return root;
}

function writePkgFile(root: string, rel: string, content: string, encoding: BufferEncoding = "utf8"): string {
	const full = path.join(root, rel);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, content, encoding);
	return full;
}

// --- pure: patchWorkflowClampInSource ---

const RESOLVE_WORKFLOW_SRC = [
	"function resolveWorkflow(input: unknown, hasUI: boolean): WebSearchWorkflow {",
	'\tconst normalized = typeof input === "string" ? input.trim().toLowerCase() : "";',
	'\tif (normalized === "auto-summary") return "auto-summary";',
	'\tif (!hasUI) return "none";',
	'\tif (normalized === "none") return "none";',
	'\treturn "summary-review";',
	"}",
].join("\n");

const WORKFLOW_ENUM_SRC = [
	'\t\t\tworkflow: Type.Optional(',
	'\t\t\t\tStringEnum(["none", "summary-review", "auto-summary"], {',
	'\t\t\t\t\tdescription: "Search workflow mode: none = no curator, summary-review = open curator with auto summary draft (default), auto-summary = generate summary without opening curator",',
	'\t\t\t\t}),',
	'\t\t\t),',
].join("\n");

const WORKFLOW_DESCRIPTION_SRC = [
	'\t\tdescription:',
	'\t\t\t`Search the web using OpenAI, Brave, Parallel, Tavily, Exa, Perplexity, or Gemini. Returns an AI-synthesized answer with source citations. OpenAI web_search uses a Codex subscription or OpenAI API key. For comprehensive research, prefer queries (plural) with 2-4 varied angles over a single query — each query gets its own synthesized answer, so varying phrasing and scope gives much broader coverage. When includeContent is true, full page content is fetched in the background. Searches auto-open the interactive browser curator and stream results live; set workflow to "none" to skip curation or "auto-summary" for a model-generated summary without the browser curator. Provider auto-selects: OpenAI when suitable and available, then Exa, Brave, Parallel, Tavily, Perplexity, Gemini API, then Gemini Web.`,',
].join("\n");

const WORKFLOW_DESCRIPTION_FIXED_SUBSTRING =
	'Only raw search results are returned in this deployment — the interactive curator and LLM summary modes are disabled (workflow is fixed to "none").';

test("patchWorkflowClampInSource rewrites resolveWorkflow to always return none", () => {
	const out = patchWorkflowClampInSource(RESOLVE_WORKFLOW_SRC);
	assert.equal(
		out,
		[
			"function resolveWorkflow(input: unknown, hasUI: boolean): WebSearchWorkflow {",
			'\treturn "none";',
			"}",
		].join("\n"),
	);
});

test("patchWorkflowClampInSource reduces the workflow enum to [none]", () => {
	const out = patchWorkflowClampInSource(WORKFLOW_ENUM_SRC);
	assert.ok(out.includes('StringEnum(["none"],'), `expected clamped enum, got:\n${out}`);
	assert.ok(!out.includes('"summary-review"'), `summary-review must be gone from enum, got:\n${out}`);
	assert.ok(!out.includes('"auto-summary"'), `auto-summary must be gone from enum, got:\n${out}`);
});

test("patchWorkflowClampInSource handles both sites in one pass", () => {
	const src = `${RESOLVE_WORKFLOW_SRC}\n\n${WORKFLOW_ENUM_SRC}`;
	const out = patchWorkflowClampInSource(src);
	assert.ok(out.includes('return "none";'), 'resolveWorkflow should be clamped');
	assert.ok(out.includes('StringEnum(["none"],'), 'enum should be clamped');
	assert.ok(!out.includes('return "summary-review";'), 'no summary-review return');
	assert.ok(!out.includes('return "auto-summary";'), 'no auto-summary return');
});

test("patchWorkflowClampInSource is idempotent (already-clamped source is unchanged)", () => {
	const clamped = patchWorkflowClampInSource(RESOLVE_WORKFLOW_SRC);
	assert.equal(patchWorkflowClampInSource(clamped), clamped);
});

// --- pure: patchWorkflowDescriptionInSource ---

test("patchWorkflowDescriptionInSource rewrites the misleading curator sentence", () => {
	const out = patchWorkflowDescriptionInSource(WORKFLOW_DESCRIPTION_SRC);
	assert.ok(
		out.includes(WORKFLOW_DESCRIPTION_FIXED_SUBSTRING),
		`expected fixed description, got:\n${out}`,
	);
	assert.ok(
		!out.includes("auto-open the interactive browser curator"),
		"misleading curator sentence should be gone",
	);
	assert.ok(!out.includes('"auto-summary"'), "auto-summary mention should be gone from description");
});

test("patchWorkflowDescriptionInSource is idempotent (already-patched source is unchanged)", () => {
	const patched = patchWorkflowDescriptionInSource(WORKFLOW_DESCRIPTION_SRC);
	assert.equal(patchWorkflowDescriptionInSource(patched), patched);
});

test("patchWorkflowDescriptionInSource leaves source without the sentence untouched", () => {
	const src = 'export const x = 1;\n';
	assert.equal(patchWorkflowDescriptionInSource(src), src);
});

test("patchWorkflowClampInSource leaves source without the sites untouched", () => {
	const src = 'export const x = 1;\nimport { complete } from "@earendil-works/pi-ai/compat";\n';
	assert.equal(patchWorkflowClampInSource(src), src);
});

test("patchWorkflowClampInSource is tolerant of a changed resolveWorkflow signature", () => {
	const src = [
		"function resolveWorkflow(input: string | undefined, ctx: { hasUI: boolean }): WebSearchWorkflow {",
		'\treturn "summary-review";',
		"}",
].join("\n");
	const out = patchWorkflowClampInSource(src);
	assert.ok(out.includes('return "none";'), `signature-tolerant match should still clamp, got:\n${out}`);
});

// --- fs: patchWorkflowClampFiles ---

test("patchWorkflowClampFiles clamps index.ts and reports one write", async () => {
	const root = makePkg();
	try {
		writeFileSync(path.join(root, "index.ts"), RESOLVE_WORKFLOW_SRC + "\n", "utf8");
		writeFileSync(path.join(root, "plain.ts"), 'export const x = 1;\n', "utf8");
		const patched = await patchWorkflowClampFiles(root);
		assert.equal(patched, 1);
		assert.equal(
			readFileSync(path.join(root, "index.ts"), "utf8"),
			[
				"function resolveWorkflow(input: unknown, hasUI: boolean): WebSearchWorkflow {",
				'\treturn "none";',
			"}",
			"",
			].join("\n"),
		);
		assert.equal(readFileSync(path.join(root, "plain.ts"), "utf8"), 'export const x = 1;\n');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("patchWorkflowClampFiles is idempotent (second run writes nothing)", async () => {
	const root = makePkg();
	try {
		const f = path.join(root, "index.ts");
		writeFileSync(f, RESOLVE_WORKFLOW_SRC + "\n", "utf8");
		assert.equal(await patchWorkflowClampFiles(root), 1);
		assert.equal(await patchWorkflowClampFiles(root), 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// --- fs: patchWorkflowDescriptionFiles ---

test("patchWorkflowDescriptionFiles rewrites the misleading description in index.ts", async () => {
	const root = makePkg();
	try {
		writeFileSync(path.join(root, "index.ts"), WORKFLOW_DESCRIPTION_SRC + "\n", "utf8");
		writeFileSync(path.join(root, "plain.ts"), 'export const x = 1;\n', "utf8");
		const patched = await patchWorkflowDescriptionFiles(root);
		assert.equal(patched, 1);
		const out = readFileSync(path.join(root, "index.ts"), "utf8");
		assert.ok(out.includes(WORKFLOW_DESCRIPTION_FIXED_SUBSTRING), `expected fixed description, got:\n${out}`);
		assert.ok(!out.includes("auto-open the interactive browser curator"), "misleading sentence should be gone");
		assert.equal(readFileSync(path.join(root, "plain.ts"), "utf8"), 'export const x = 1;\n');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("patchWorkflowDescriptionFiles is idempotent (second run writes nothing)", async () => {
	const root = makePkg();
	try {
		const f = path.join(root, "index.ts");
		writeFileSync(f, WORKFLOW_DESCRIPTION_SRC + "\n", "utf8");
		assert.equal(await patchWorkflowDescriptionFiles(root), 1);
		assert.equal(await patchWorkflowDescriptionFiles(root), 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// --- fs: applyWebAccessGuard (workflow clamp) ---

test("applyWebAccessGuard clamps workflow without rewriting pi-ai compat imports", async () => {
	const root = makePkg();
	try {
		writeFileSync(
			path.join(root, "index.ts"),
			`${RESOLVE_WORKFLOW_SRC}\n\nimport { complete } from "@earendil-works/pi-ai/compat";\n`,
			"utf8",
		);
		await applyWebAccessGuard(root);
		const out = readFileSync(path.join(root, "index.ts"), "utf8");
		assert.ok(out.includes('return "none";'), 'workflow should be clamped');
		assert.ok(!out.includes('return "summary-review";'), 'summary-review return should be gone');
		assert.ok(
			out.includes('from "@earendil-works/pi-ai/compat";'),
			'pi-web-access 0.27 requires the compat entrypoint and it must be preserved',
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("applyWebAccessGuard also patches the workflow description", async () => {
	const root = makePkg();
	try {
		writeFileSync(path.join(root, "index.ts"), WORKFLOW_DESCRIPTION_SRC + "\n", "utf8");
		await applyWebAccessGuard(root);
		const out = readFileSync(path.join(root, "index.ts"), "utf8");
		assert.ok(
			out.includes(WORKFLOW_DESCRIPTION_FIXED_SUBSTRING),
			`description should match clamped behavior, got:\n${out}`,
		);
		assert.ok(!out.includes("auto-open the interactive browser curator"), "misleading sentence should be gone");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// --- pure: delete-artifact helpers ---

test("isDeleteArtifact recognises npm rename artifacts", () => {
	assert.equal(isDeleteArtifact("Readability.js.DELETE.e90203593ab2f7c54e4046ca5ca7f373"), true);
	assert.equal(isDeleteArtifact("index.js.DELETE.abc"), true);
});

test("isDeleteArtifact rejects ordinary file names", () => {
	assert.equal(isDeleteArtifact("Readability.js"), false);
	assert.equal(isDeleteArtifact("index.js"), false);
	assert.equal(isDeleteArtifact("foo.DELETE"), false); // no hash segment
});

test("stripDeleteSuffix recovers the original name", () => {
	assert.equal(
		stripDeleteSuffix("Readability.js.DELETE.e90203593ab2f7c54e4046ca5ca7f373"),
		"Readability.js",
	);
	assert.equal(stripDeleteSuffix("index.js.DELETE.abc"), "index.js");
	assert.equal(stripDeleteSuffix("plain.js"), "plain.js");
});

// --- fs: repairDeleteArtifacts ---

test("repairDeleteArtifacts renames a .DELETE artifact back when no original exists", async () => {
	const root = makePkg();
	try {
		const dir = path.join(root, "node_modules", "@mozilla", "readability");
		writePkgFile(root, "node_modules/@mozilla/readability/index.js", 'require("./Readability");');
		const artifact = path.join(dir, "Readability.js.DELETE.e90203593ab2f7c54e4046ca5ca7f373");
		writeFileSync(artifact, "module.exports = {};", "utf8");

		const restored = await repairDeleteArtifacts(root);
		assert.equal(restored, 1);
		assert.equal(existsSync(artifact), false);
		assert.equal(existsSync(path.join(dir, "Readability.js")), true);
		// the unrelated real file is untouched
		assert.equal(
			readFileSync(path.join(dir, "index.js"), "utf8"),
			'require("./Readability");',
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("repairDeleteArtifacts keeps a .DELETE artifact when a real file already exists", async () => {
	const root = makePkg();
	try {
		const dir = path.join(root, "node_modules", "pkg");
		writePkgFile(root, "node_modules/pkg/foo.js", "real", "utf8");
		const artifact = path.join(dir, "foo.js.DELETE.deadbeef");
		writeFileSync(artifact, "stale", "utf8");

		assert.equal(await repairDeleteArtifacts(root), 0);
		assert.equal(existsSync(path.join(dir, "foo.js")), true);
		assert.equal(existsSync(artifact), true); // preserved, not clobbered
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("repairDeleteArtifacts recurses into nested node_modules", async () => {
	const root = makePkg();
	try {
		writePkgFile(
			root,
			"node_modules/@aws-sdk/credential-provider-process/dist-cjs/index.js.DELETE.bee575",
			"old",
			"utf8",
		);
		const restored = await repairDeleteArtifacts(root);
		assert.equal(restored, 1);
		assert.equal(
			existsSync(
				path.join(root, "node_modules/@aws-sdk/credential-provider-process/dist-cjs/index.js"),
			),
			true,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("repairDeleteArtifacts is idempotent", async () => {
	const root = makePkg();
	try {
		writePkgFile(root, "node_modules/@mozilla/readability/Readability.js.DELETE.hash", "x", "utf8");
		assert.equal(await repairDeleteArtifacts(root), 1);
		assert.equal(await repairDeleteArtifacts(root), 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// --- fs: readabilityIntact ---

test("readabilityIntact is true when Readability.js resolves", async () => {
	const root = makePkg();
	try {
		writePkgFile(root, "package.json", '{"name":"pi-web-access","version":"0.0.0"}', "utf8");
		writePkgFile(
			root,
			"node_modules/@mozilla/readability/package.json",
			'{"name":"@mozilla/readability","main":"index.js"}',
			"utf8",
		);
		writePkgFile(
			root,
			"node_modules/@mozilla/readability/index.js",
			'module.exports={};',
			"utf8",
		);
		writePkgFile(
			root,
			"node_modules/@mozilla/readability/Readability.js",
			"module.exports = {};",
			"utf8",
		);
		assert.equal(await readabilityIntact(root), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("readabilityIntact is false when Readability.js is missing (corrupted)", async () => {
	const root = makePkg();
	try {
		writePkgFile(root, "package.json", '{"name":"pi-web-access","version":"0.0.0"}', "utf8");
		writePkgFile(
			root,
			"node_modules/@mozilla/readability/package.json",
			'{"name":"@mozilla/readability","main":"index.js"}',
			"utf8",
		);
		writePkgFile(root, "node_modules/@mozilla/readability/index.js", 'require("./Readability");', "utf8");
		// no Readability.js — only the .DELETE artifact
		writePkgFile(
			root,
			"node_modules/@mozilla/readability/Readability.js.DELETE.hash",
			"x",
			"utf8",
		);
		assert.equal(await readabilityIntact(root), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// --- fs: applyWebAccessGuard (orchestration) ---

test("applyWebAccessGuard preserves compat imports and repairs corruption in one pass", async () => {
	const root = makePkg();
	try {
		writeFileSync(
			path.join(root, "index.ts"),
			'import { complete } from "@earendil-works/pi-ai/compat";\n',
			"utf8",
		);
		const dir = path.join(root, "node_modules", "@mozilla", "readability");
		writePkgFile(root, "node_modules/@mozilla/readability/index.js", 'require("./Readability");');
		writeFileSync(path.join(dir, "Readability.js.DELETE.hash"), "x", "utf8");
		// no Readability.js present → corruption

		await applyWebAccessGuard(root);

		assert.equal(
			readFileSync(path.join(root, "index.ts"), "utf8"),
			'import { complete } from "@earendil-works/pi-ai/compat";\n',
		);
		assert.equal(existsSync(path.join(dir, "Readability.js")), true);
		assert.equal(existsSync(path.join(dir, "Readability.js.DELETE.hash")), false);
		assert.equal(await readabilityIntact(root), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("applyWebAccessGuard skips the repair walk when node_modules is healthy", async () => {
	const root = makePkg();
	try {
		writeFileSync(path.join(root, "index.ts"), 'import { complete } from "@earendil-works/pi-ai";\n', "utf8");
		writePkgFile(root, "package.json", '{"name":"pi-web-access","version":"0.0.0"}', "utf8");
		writePkgFile(
			root,
			"node_modules/@mozilla/readability/package.json",
			'{"name":"@mozilla/readability","main":"index.js"}',
			"utf8",
		);
		writePkgFile(root, "node_modules/@mozilla/readability/index.js", "module.exports={};", "utf8");
		writePkgFile(root, "node_modules/@mozilla/readability/Readability.js", "module.exports = {};", "utf8");

		// Should not throw and should leave everything intact.
		await applyWebAccessGuard(root);
		assert.equal(await readabilityIntact(root), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// --- runSelfHeal (injectable resolver) ---

test("runSelfHeal applies workflow policy when the resolver returns a root", async () => {
	const root = makePkg();
	try {
		writeFileSync(path.join(root, "index.ts"), `${RESOLVE_WORKFLOW_SRC}\n`, "utf8");
		await runSelfHeal(() => root);
		const out = readFileSync(path.join(root, "index.ts"), "utf8");
		assert.ok(out.includes('return "none";'));
		assert.ok(!out.includes('return "summary-review";'));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("runSelfHeal is a no-op when the resolver returns null", async () => {
	const root = makePkg();
	try {
		writeFileSync(
			path.join(root, "index.ts"),
			'import { complete } from "@earendil-works/pi-ai/compat";\n',
			"utf8",
		);
		await runSelfHeal(() => null);
		// nothing patched
		assert.equal(
			readFileSync(path.join(root, "index.ts"), "utf8"),
			'import { complete } from "@earendil-works/pi-ai/compat";\n',
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("runSelfHeal swallows a throwing resolver (never breaks loading)", async () => {
	const root = makePkg();
	try {
		writeFileSync(
			path.join(root, "index.ts"),
			'import { complete } from "@earendil-works/pi-ai/compat";\n',
			"utf8",
		);
		await assert.doesNotReject(async () =>
			runSelfHeal(() => {
				throw new Error("boom");
			}),
		);
		// untouched because resolver threw before patching
		assert.equal(
			readFileSync(path.join(root, "index.ts"), "utf8"),
			'import { complete } from "@earendil-works/pi-ai/compat";\n',
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// --- resolvePackageRoot (managed install only) ---

/** Real-fs existence probe mirroring the production dep's contract. */
async function testPathExists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

function lookupDeps(agentDir: string, homeDir = os.homedir()): PackageRootLookupDeps {
	return {
		getAgentDir: () => agentDir,
		getHomeDir: () => homeDir,
		pathExists: testPathExists,
	};
}

test("resolvePackageRoot returns the active managed install", async () => {
	const agentDir = makePkg();
	try {
		writePkgFile(agentDir, "npm/node_modules/pi-web-access/package.json", '{"name":"pi-web-access"}');
		assert.equal(
			await resolvePackageRoot(lookupDeps(agentDir)),
			path.join(agentDir, "npm", "node_modules", "pi-web-access"),
		);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("resolvePackageRoot expands a tilde-prefixed managed agent directory", async () => {
	const homeDir = makePkg();
	try {
		writePkgFile(homeDir, "agent/npm/node_modules/pi-web-access/package.json", '{"name":"pi-web-access"}');
		assert.equal(
			await resolvePackageRoot(lookupDeps("~/agent", homeDir)),
			path.join(homeDir, "agent", "npm", "node_modules", "pi-web-access"),
		);
	} finally {
		rmSync(homeDir, { recursive: true, force: true });
	}
});

test("resolvePackageRoot returns null when the managed package is absent", async () => {
	const agentDir = makePkg();
	try {
		assert.equal(await resolvePackageRoot(lookupDeps(agentDir)), null);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

// --- current pi-web-access 0.27.0 source-shape contract ---
//
// Fixtures below are literal excerpts from the published
// pi-web-access@0.27.0 npm tarball (checked against it at authoring time).
// They pin the regexes against the exact upstream wording currently shipped,
// so a silent regex miss (the pass becoming a no-op on a real install) fails
// here first.

/** Verbatim `resolveWorkflow` from 0.27.0's index.ts. */
const V027_RESOLVE_WORKFLOW_SRC = [
	"function resolveWorkflow(input: unknown, hasUI: boolean): WebSearchWorkflow {",
	'\tconst normalized = typeof input === "string" ? input.trim().toLowerCase() : "";',
	'\tif (normalized === "auto-summary") return "auto-summary";',
	'\tif (!hasUI) return "none";',
	'\tif (normalized === "none") return "none";',
	'\treturn "summary-review";',
	"}",
].join("\n");

/**
 * Verbatim `workflow` schema block from 0.27.0's index.ts (real nesting: the
 * `research` params object adds one tab level).
 */
const V027_WORKFLOW_ENUM_SRC = [
	'\t\t\tworkflow: Type.Optional(',
	'\t\t\t\tStringEnum(["none", "summary-review", "auto-summary"], {',
	'\t\t\t\t\tdescription: "Search workflow mode: none = no curator, summary-review = open curator with auto summary draft (default), auto-summary = generate summary without opening curator",',
	'\t\t\t\t}),',
	'\t\t\t),',
].join("\n");

/**
 * The curator sentence inside 0.27.0's `web_search` `description`, embedded in
 * its surrounding template-literal prose (the middle of the much longer
 * published description is elided for brevity; the sentence itself is exact).
 */
const V027_WEB_SEARCH_DESCRIPTION_SRC = [
	'\t\tdescription:',
	'\t\t\t`Search the web using OpenAI, Brave, Parallel, Tavily, Exa, Perplexity, or Gemini. Returns an AI-synthesized answer with source citations. For comprehensive research, prefer queries (plural) with 2-4 varied angles over a single query. When includeContent is true, full page content is fetched in the background. Searches auto-open the interactive browser curator and stream results live; set workflow to "none" to skip curation or "auto-summary" for a model-generated summary without the browser curator. The configured provider is used when provider is omitted or set to auto; omit provider unless explicitly overriding it.`,',
].join("\n");

test("0.27: patchWorkflowClampInSource clamps the verbatim resolveWorkflow", () => {
	const out = patchWorkflowClampInSource(V027_RESOLVE_WORKFLOW_SRC);
	assert.equal(
		out,
		[
			"function resolveWorkflow(input: unknown, hasUI: boolean): WebSearchWorkflow {",
			'\treturn "none";',
			"}",
		].join("\n"),
	);
});

test("0.27: patchWorkflowClampInSource reduces the verbatim workflow enum to [none]", () => {
	const out = patchWorkflowClampInSource(V027_WORKFLOW_ENUM_SRC);
	assert.ok(out.includes('StringEnum(["none"],'), `expected clamped enum, got:\n${out}`);
	assert.ok(!out.includes('"summary-review"'), `summary-review must be gone, got:\n${out}`);
	assert.ok(!out.includes('"auto-summary"'), `auto-summary must be gone, got:\n${out}`);
});

test("0.27: patchWorkflowDescriptionInSource fixes the curator sentence mid-template", () => {
	const out = patchWorkflowDescriptionInSource(V027_WEB_SEARCH_DESCRIPTION_SRC);
	assert.ok(
		out.includes(WORKFLOW_DESCRIPTION_FIXED_SUBSTRING),
		`expected fixed description, got:\n${out}`,
	);
	assert.ok(!out.includes("Searches auto-open"), "misleading sentence should be gone");
	// neighbouring sentences in the same template literal are preserved
	assert.ok(
		out.includes("The configured provider is used when provider is omitted or set to auto"),
		"surrounding template prose must be preserved",
	);
});

test("0.27: applyWebAccessGuard enforces policy while preserving the required compat import", async () => {
	const root = makePkg();
	try {
		const compatImport =
			'import { StringEnum, type ImageContent, type TextContent } from "@earendil-works/pi-ai/compat";';
		writeFileSync(
			path.join(root, "index.ts"),
			`${compatImport}\n\n${V027_RESOLVE_WORKFLOW_SRC}\n\n${V027_WORKFLOW_ENUM_SRC}\n\n${V027_WEB_SEARCH_DESCRIPTION_SRC}`,
			"utf8",
		);

		await applyWebAccessGuard(root);

		const firstPass = readFileSync(path.join(root, "index.ts"), "utf8");
		await applyWebAccessGuard(root);
		assert.equal(readFileSync(path.join(root, "index.ts"), "utf8"), firstPass, "second pass must be a no-op");
		assert.ok(firstPass.includes(compatImport), "the pi-ai compat entrypoint must be preserved");
		assert.ok(firstPass.includes('\treturn "none";\n}'), "resolveWorkflow should be clamped");
		assert.ok(
			!firstPass.includes('return "summary-review";') && !firstPass.includes('return "auto-summary";'),
			"no summary returns should survive",
		);
		assert.ok(firstPass.includes('StringEnum(["none"],'), "enum should be clamped");
		assert.ok(!firstPass.includes('StringEnum(["none", "summary-review"'), "three-value enum should be gone");
		assert.ok(
			firstPass.includes(WORKFLOW_DESCRIPTION_FIXED_SUBSTRING),
			"description should match the clamped behavior",
		);
		assert.ok(!firstPass.includes("Searches auto-open"), "misleading sentence should be gone");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
