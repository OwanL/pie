/**
 * Tests for the web-access-compat self-heal extension.
 *
 * Covers the pure rewrite/strip helpers and the filesystem patch+repair logic
 * against a real temp-dir "package" (no SDK, no LLM, no network). The
 * env-glue (resolvePackageRoot / the default factory) is exercised only via
 * the injectable `runSelfHeal(resolveRoot)`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyCompatFixes,
	execText,
	isDeleteArtifact,
	patchCompatFiles,
	patchCompatInSource,
	patchWorkflowClampFiles,
	patchWorkflowClampInSource,
	patchWorkflowDescriptionFiles,
	patchWorkflowDescriptionInSource,
	readabilityIntact,
	repairDeleteArtifacts,
	runSelfHeal,
	stripDeleteSuffix,
} from "../index.js";

function makePkg() {
	const root = mkdtempSync(path.join(os.tmpdir(), "wac-"));
	return root;
}

function writePkgFile(root: string, rel: string, content: string, encoding: BufferEncoding = "utf8"): string {
	const full = path.join(root, rel);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, content, encoding);
	return full;
}

// --- execText (shell glue) ---

test("execText returns trimmed stdout for a successful command", () => {
	const out = execText('echo hello');
	assert.equal(out, "hello");
});

test("execText returns null for a failing command", () => {
	assert.equal(execText('exit 1'), null);
});

// --- pure: patchCompatInSource ---

test("patchCompatInSource rewrites a double-quoted static import", () => {
	const out = patchCompatInSource(
		'import { StringEnum, complete, type Model } from "@earendil-works/pi-ai/compat";',
	);
	assert.equal(out, 'import { StringEnum, complete, type Model } from "@earendil-works/pi-ai";');
});

test("patchCompatInSource rewrites a dynamic import() and single quotes", () => {
	const out = patchCompatInSource(
		`const { getModel } = await import('@earendil-works/pi-ai/compat');`,
	);
	assert.equal(out, `const { getModel } = await import('@earendil-works/pi-ai');`);
});

test("patchCompatInSource leaves a longer subpath like /compatibility untouched", () => {
	const src = 'import { x } from "@earendil-works/pi-ai/compatibility";';
	assert.equal(patchCompatInSource(src), src);
});

test("patchCompatInSource is idempotent (already-patched source is unchanged)", () => {
	const src = 'import { complete } from "@earendil-works/pi-ai";';
	assert.equal(patchCompatInSource(src), src);
});

test("patchCompatInSource handles multiple occurrences in one file", () => {
	const out = patchCompatInSource(
		'import { a } from "@earendil-works/pi-ai/compat";\nimport("@earendil-works/pi-ai/compat");',
	);
	assert.equal(out, 'import { a } from "@earendil-works/pi-ai";\nimport("@earendil-works/pi-ai");');
});

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

// --- fs: applyCompatFixes (workflow clamp) ---

test("applyCompatFixes applies both the compat import fix and the workflow clamp", async () => {
	const root = makePkg();
	try {
		writeFileSync(
			path.join(root, "index.ts"),
			`${RESOLVE_WORKFLOW_SRC}\n\nimport { complete } from "@earendil-works/pi-ai/compat";\n`,
			"utf8",
		);
		await applyCompatFixes(root);
		const out = readFileSync(path.join(root, "index.ts"), "utf8");
		assert.ok(out.includes('return "none";'), 'workflow should be clamped');
		assert.ok(!out.includes('return "summary-review";'), 'summary-review return should be gone');
		assert.ok(out.includes('from "@earendil-works/pi-ai";'), 'compat import should be rewritten');
		assert.ok(!out.includes('pi-ai/compat'), 'compat subpath should be gone');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("applyCompatFixes also patches the workflow description", async () => {
	const root = makePkg();
	try {
		writeFileSync(path.join(root, "index.ts"), WORKFLOW_DESCRIPTION_SRC + "\n", "utf8");
		await applyCompatFixes(root);
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

// --- fs: patchCompatFiles ---

test("patchCompatFiles patches only .ts/.js sources containing the specifier", async () => {
	const root = makePkg();
	try {
		writeFileSync(
			path.join(root, "index.ts"),
			'import { complete } from "@earendil-works/pi-ai/compat";\n',
			"utf8",
		);
		writeFileSync(
			path.join(root, "summary-review.ts"),
			'import { complete, type Model } from "@earendil-works/pi-ai/compat";\n',
			"utf8",
		);
		writeFileSync(path.join(root, "plain.ts"), 'export const x = 1;\n', "utf8");
		writeFileSync(path.join(root, "README.md"), "# nope", "utf8");

		const patched = await patchCompatFiles(root);
		assert.equal(patched, 2);
		assert.equal(
			readFileSync(path.join(root, "index.ts"), "utf8"),
			'import { complete } from "@earendil-works/pi-ai";\n',
		);
		assert.equal(
			readFileSync(path.join(root, "summary-review.ts"), "utf8"),
			'import { complete, type Model } from "@earendil-works/pi-ai";\n',
		);
		assert.equal(readFileSync(path.join(root, "plain.ts"), "utf8"), 'export const x = 1;\n');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("patchCompatFiles is idempotent (second run writes nothing)", async () => {
	const root = makePkg();
	try {
		const f = path.join(root, "index.ts");
		writeFileSync(f, 'import { complete } from "@earendil-works/pi-ai/compat";\n', "utf8");
		assert.equal(await patchCompatFiles(root), 1);
		assert.equal(await patchCompatFiles(root), 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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

// --- fs: applyCompatFixes (orchestration) ---

test("applyCompatFixes patches the import AND repairs corruption in one pass", async () => {
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

		await applyCompatFixes(root);

		assert.equal(
			readFileSync(path.join(root, "index.ts"), "utf8"),
			'import { complete } from "@earendil-works/pi-ai";\n',
		);
		assert.equal(existsSync(path.join(dir, "Readability.js")), true);
		assert.equal(existsSync(path.join(dir, "Readability.js.DELETE.hash")), false);
		assert.equal(await readabilityIntact(root), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("applyCompatFixes skips the repair walk when node_modules is healthy", async () => {
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
		await applyCompatFixes(root);
		assert.equal(await readabilityIntact(root), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// --- runSelfHeal (injectable resolver) ---

test("runSelfHeal applies fixes when the resolver returns a root", async () => {
	const root = makePkg();
	try {
		writeFileSync(
			path.join(root, "index.ts"),
			'import { complete } from "@earendil-works/pi-ai/compat";\n',
			"utf8",
		);
		await runSelfHeal(() => root);
		assert.equal(
			readFileSync(path.join(root, "index.ts"), "utf8"),
			'import { complete } from "@earendil-works/pi-ai";\n',
		);
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
