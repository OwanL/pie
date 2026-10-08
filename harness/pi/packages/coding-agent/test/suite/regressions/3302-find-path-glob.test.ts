import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFindToolDefinition } from "../../../src/core/tools/find.ts";
import { DEFAULT_MAX_BYTES } from "../../../src/core/tools/truncate.ts";
import { getToolPath } from "../../../src/utils/tools-manager.ts";

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

/**
 * Regression test for https://github.com/earendil-works/pi-mono/issues/3302
 *
 * The `find` tool advertises glob patterns like `src/**\/*.spec.ts`, but the
 * default fd-backed implementation used `fd --glob <pattern>` without
 * `--full-path`, which makes fd match only against the basename. Any pattern
 * containing a `/` therefore silently returned no matches.
 *
 * Windows path globs use Minimatch's relative-path matcher after fd discovery;
 * POSIX keeps fd full-path matching. Native fd preflight retains glob errors.
 */
// Check before constructing/executing the tool: this source-only suite must never
// download fd when the native dependency is unavailable.
describe.skipIf(!getToolPath("fd"))("issue #3302 find returns no results for path-based glob patterns", () => {
	let tempRoot: string;

	beforeEach(() => {
		vi.mocked(spawn).mockClear();
		tempRoot = mkdtempSync(join(tmpdir(), "pi-3302-"));
		mkdirSync(join(tempRoot, "some", "parent", "child"), { recursive: true });
		mkdirSync(join(tempRoot, "src", "foo", "bar"), { recursive: true });
		writeFileSync(join(tempRoot, "some", "parent", "child", "file.ext"), "");
		writeFileSync(join(tempRoot, "some", "parent", "child", "test.spec.ts"), "");
		writeFileSync(join(tempRoot, "src", "foo", "bar", "example.spec.ts"), "");
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	async function runFind(pattern: string): Promise<string[]> {
		const def = createFindToolDefinition(tempRoot);
		// The find tool implementation does not touch ctx; pass a minimal stub.
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute("call-1", { pattern }, undefined, undefined, ctx)) as {
			content: Array<{ type: string; text?: string }>;
		};
		const text = result.content[0]?.text ?? "";
		if (text === "No files found matching pattern") return [];
		return text
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith("["));
	}

	it("basename pattern still matches (regression-safe)", async () => {
		const files = await runFind("*.spec.ts");
		expect(files.sort()).toEqual(["some/parent/child/test.spec.ts", "src/foo/bar/example.spec.ts"]);
	});

	it("directory-prefixed pattern with ** tail matches subtree", async () => {
		const files = await runFind("some/parent/child/**");
		// Matches files (and possibly directories) under the subtree. Assert the two files are present.
		expect(files).toContain("some/parent/child/file.ext");
		expect(files).toContain("some/parent/child/test.spec.ts");
	});

	it("leading ** wildcard with path segments matches", async () => {
		const files = await runFind("**/parent/child/*");
		expect(files.sort()).toContain("some/parent/child/file.ext");
		expect(files.sort()).toContain("some/parent/child/test.spec.ts");
	});

	it("src/**/*.spec.ts matches nested spec file", async () => {
		const files = await runFind("src/**/*.spec.ts");
		expect(files).toEqual(["src/foo/bar/example.spec.ts"]);
	});

	it("src/**/*.spec.ts includes zero-directory and deeply nested matches", async () => {
		mkdirSync(join(tempRoot, "src", "foo", "bar", "deep"), { recursive: true });
		writeFileSync(join(tempRoot, "src", "direct.spec.ts"), "");
		writeFileSync(join(tempRoot, "src", "foo", "bar", "deep", "nested.spec.ts"), "");
		expect((await runFind("src/**/*.spec.ts")).sort()).toEqual([
			"src/direct.spec.ts",
			"src/foo/bar/deep/nested.spec.ts",
			"src/foo/bar/example.spec.ts",
		]);
	});

	it("**/*.spec.ts includes root, direct-child and deeply nested matches", async () => {
		mkdirSync(join(tempRoot, "src", "foo", "bar", "deep"), { recursive: true });
		writeFileSync(join(tempRoot, "root.spec.ts"), "");
		writeFileSync(join(tempRoot, "src", "direct.spec.ts"), "");
		writeFileSync(join(tempRoot, "src", "foo", "bar", "deep", "nested.spec.ts"), "");
		expect((await runFind("**/*.spec.ts")).sort()).toEqual([
			"root.spec.ts",
			"some/parent/child/test.spec.ts",
			"src/direct.spec.ts",
			"src/foo/bar/deep/nested.spec.ts",
			"src/foo/bar/example.spec.ts",
		]);
	});

	it("path globs include hidden files and hidden directory descendants", async () => {
		mkdirSync(join(tempRoot, ".secret"));
		writeFileSync(join(tempRoot, ".secret", "hidden.txt"), "");
		writeFileSync(join(tempRoot, ".hidden.txt"), "");
		expect((await runFind("**/*.txt")).sort()).toEqual([".hidden.txt", ".secret/hidden.txt"]);
		expect(await runFind(".secret/*.txt")).toEqual([".secret/hidden.txt"]);
		expect(await runFind("**/.hidden.txt")).toEqual([".hidden.txt"]);
	});

	it("path globs preserve native fd smart-case matching", async () => {
		writeFileSync(join(tempRoot, "UPPER.txt"), "");
		for (const pattern of ["upper.txt", "Upper.txt"]) {
			const native = spawnSync(getToolPath("fd")!, [
				"--glob",
				"--hidden",
				"--no-require-git",
				"--color=never",
				"--",
				pattern,
				tempRoot,
			]);
			expect(native.status).toBe(0);
			const files = native.stdout.toString().trim().split(/\r?\n/).filter(Boolean)
				.map((filename) => filename.replaceAll("\\", "/").slice(tempRoot.replaceAll("\\", "/").length + 1)).sort();
			expect(files).toEqual(pattern === "upper.txt" ? ["UPPER.txt"] : []);
			expect((await runFind(`**/${pattern}`)).sort()).toEqual(files);
		}
	});

	it("path globs treat extglob-looking filenames literally like native fd", async () => {
		writeFileSync(join(tempRoot, "src", "@(literal).ts"), "");
		writeFileSync(join(tempRoot, "src", "literal.ts"), "");
		const native = spawnSync(getToolPath("fd")!, [
			"--glob",
			"--hidden",
			"--no-require-git",
			"--color=never",
			"--",
			"@(literal).ts",
			join(tempRoot, "src"),
		]);
		expect(native.status).toBe(0);
		expect(
			native.stdout
				.toString()
				.trim()
				.split(/\r?\n/)
				.map((filename) => filename.replaceAll("\\", "/")),
		).toEqual([join(tempRoot, "src", "@(literal).ts").replaceAll("\\", "/")]);
		expect(await runFind("src/@(literal).ts")).toEqual(["src/@(literal).ts"]);
	});

	for (const prefix of ["!", "#"]) {
		it(`path globs treat leading ${prefix} literally like native fd`, async () => {
			mkdirSync(join(tempRoot, `${prefix}src`));
			writeFileSync(join(tempRoot, `${prefix}src`, "name.txt"), "");
			writeFileSync(join(tempRoot, "src", "name.txt"), "");
			writeFileSync(join(tempRoot, `${prefix}name.txt`), "");
			writeFileSync(join(tempRoot, "name.txt"), "");
			// Basename probes avoid Windows fd's full-path separator mismatch.
			const native = spawnSync(getToolPath("fd")!, [
				"--glob",
				"--hidden",
				"--no-require-git",
				"--color=never",
				"--",
				`${prefix}name.txt`,
				tempRoot,
			]);
			expect(native.status).toBe(0);
			expect(
				native.stdout
					.toString()
					.trim()
					.split(/\r?\n/)
					.map((filename) => filename.replaceAll("\\", "/")),
			).toEqual([join(tempRoot, `${prefix}name.txt`).replaceAll("\\", "/")]);
			const files = await runFind(`${prefix}src/**`);
			expect(files.filter((filename) => !filename.endsWith("/"))).toEqual([`${prefix}src/name.txt`]);
			expect(files.every((filename) => filename.startsWith(`${prefix}src/`))).toBe(true);
		});
	}

	it("path glob with no matching subtree returns no files", async () => {
		expect(await runFind("missing/**/*.spec.ts")).toEqual([]);
	});

	it("invalid glob still rejects with the legacy native fd error", async () => {
		const native = spawnSync(getToolPath("fd")!, ["--glob", "--full-path", "--", "**/src/[invalid", tempRoot]);
		await expect(runFind("src/[invalid")).rejects.toThrow(native.stderr.toString().trim());
	});

	it("applies the match limit after many nonmatches", async () => {
		for (let i = 0; i < 250; i++) writeFileSync(join(tempRoot, `nonmatch-${i}.txt`), "");
		for (let i = 0; i < 20; i++) writeFileSync(join(tempRoot, "src", `match-${i}.spec.ts`), "");
		const def = createFindToolDefinition(tempRoot);
		const result = await def.execute(
			"limit",
			{ pattern: "src/**/*.spec.ts", limit: 3 },
			undefined,
			undefined,
			{} as any,
		);
		const text = result.content[0] as { text: string };
		expect(text.text.split("\n").filter((line) => line && !line.startsWith("["))).toHaveLength(3);
		expect(result.details?.resultLimitReached).toBe(3);
		if (process.platform === "win32") {
			expect(vi.mocked(spawn).mock.calls).toHaveLength(2);
			const listingArgs = vi.mocked(spawn).mock.calls[1][1] as string[];
			expect(listingArgs).not.toContain("--max-results");
			expect(listingArgs.slice(-3)).toEqual(["--", "*", tempRoot]);
		}
		for (const call of vi.mocked(spawn).mock.results) {
			expect(call.value.exitCode !== null || call.value.signalCode !== null).toBe(true);
		}
	});

	it.skipIf(process.platform !== "win32")("zero-depth native preflight parses without discovering files", () => {
		const valid = spawnSync(getToolPath("fd")!, [
			"--glob",
			"--full-path",
			"--max-depth",
			"0",
			"--",
			"**/*.spec.ts",
			tempRoot,
		]);
		expect(valid.status).toBe(0);
		expect(valid.stdout.toString()).toBe("");
		const invalid = spawnSync(getToolPath("fd")!, [
			"--glob",
			"--full-path",
			"--max-depth",
			"0",
			"--",
			"src/[invalid",
			tempRoot,
		]);
		expect(invalid.status).not.toBe(0);
		expect(invalid.stderr.toString()).toContain("unclosed character class");
	});

	for (const pattern of ["*.txt", "src/**/*.txt"]) {
		it(`budgets relative paths rather than absolute fd stdout under a long private root (${pattern})`, async () => {
			const searchRoot = join(tempRoot, "long-root-" + "x".repeat(80));
			mkdirSync(join(searchRoot, "src"), { recursive: true });
			const expected = Array.from({ length: 600 }, (_, i) => `src/f${String(i).padStart(3, "0")}.txt`);
			for (const filename of expected) writeFileSync(join(searchRoot, filename), "");
			const native = spawnSync(getToolPath("fd")!, ["--glob", "--no-require-git", "--", "*.txt", searchRoot]);
			expect(native.status).toBe(0);
			expect(native.stdout.length).toBeGreaterThan(DEFAULT_MAX_BYTES);
			expect(Buffer.byteLength(expected.join("\n"))).toBeLessThan(DEFAULT_MAX_BYTES);
			const def = createFindToolDefinition(searchRoot);
			const result = await def.execute(
				"relative",
				{ pattern },
				undefined,
				undefined,
				{} as Parameters<typeof def.execute>[4],
			);
			expect((result.content[0] as { text: string }).text.split("\n").sort()).toEqual(expected);
			expect(result.details).toBeUndefined();
		});
	}

	it("reports a genuine native relative byte cap with complete multibyte filenames", async () => {
		const expected = Array.from({ length: 600 }, (_, i) => `src/${"é".repeat(40)}-${String(i).padStart(3, "0")}.txt`);
		for (const filename of expected) writeFileSync(join(tempRoot, filename), "");
		const def = createFindToolDefinition(tempRoot);
		const result = await def.execute(
			"bytes",
			{ pattern: "src/**/*.txt" },
			undefined,
			undefined,
			{} as Parameters<typeof def.execute>[4],
		);
		const text = (result.content[0] as { text: string }).text;
		const files = text.split("\n\n")[0].split("\n");
		expect(files.length).toBeLessThan(600);
		expect(files.every((filename) => expected.includes(filename))).toBe(true);
		expect(text).toContain("[50.0KB limit reached]");
		expect(result.details?.truncation).toMatchObject({
			truncated: true,
			truncatedBy: "bytes",
			lastLinePartial: false,
		});
		expect(result.details?.truncation?.outputBytes).toBe(Buffer.byteLength(files.join("\n")));
		expect(result.details?.resultLimitReached).toBeUndefined();
		for (const call of vi.mocked(spawn).mock.results) {
			expect(call.value.exitCode !== null || call.value.signalCode !== null).toBe(true);
		}
	});

	for (const delta of [-1, 0, 1]) {
		it(`counts UTF-8 bytes and only inter-line newlines at byte cap ${delta >= 0 ? "+" : ""}${delta}`, async () => {
			const actual = await vi.importActual<typeof import("child_process")>("child_process");
			const candidates = ["é".repeat(12800), "b".repeat(DEFAULT_MAX_BYTES + delta - 25601)];
			const script = `const root=${JSON.stringify(tempRoot)}; const p=require('node:path'); process.stdout.write([p.join(root,'é'.repeat(12800)),p.join(root,'b'.repeat(${DEFAULT_MAX_BYTES + delta - 25601}))].join('\\n')+'\\n');`;
			vi.mocked(spawn).mockImplementation((() =>
				actual.spawn(process.execPath, ["-e", script], {
					stdio: ["ignore", "pipe", "pipe"],
				})) as unknown as typeof spawn);
			try {
				const def = createFindToolDefinition(tempRoot);
				const result = await def.execute(
					"boundary",
					{ pattern: "*" },
					undefined,
					undefined,
					{} as Parameters<typeof def.execute>[4],
				);
				const text = (result.content[0] as { text: string }).text;
				if (delta <= 0) {
					expect(text).toBe(candidates.join("\n"));
					expect(result.details).toBeUndefined();
				} else {
					expect(text).toBe(candidates[0] + "\n\n[50.0KB limit reached]");
					expect(result.details?.truncation).toMatchObject({
						totalBytes: DEFAULT_MAX_BYTES + 1,
						outputLines: 1,
						lastLinePartial: false,
					});
				}
			} finally {
				vi.mocked(spawn).mockImplementation(actual.spawn);
			}
		});
	}

	it("already-aborted execution never spawns fd", async () => {
		const controller = new AbortController();
		controller.abort();
		const def = createFindToolDefinition(tempRoot);
		await expect(
			def.execute(
				"aborted",
				{ pattern: "src/**/*.spec.ts" },
				controller.signal,
				undefined,
				{} as Parameters<typeof def.execute>[4],
			),
		).rejects.toThrow("Operation aborted");
		expect(vi.mocked(spawn)).not.toHaveBeenCalled();
	});

	it("spawn failure is reported only after the owned child closes", async () => {
		const actual = await vi.importActual<typeof import("child_process")>("child_process");
		let closed = false;
		vi.mocked(spawn).mockImplementation((() => {
			const child = actual.spawn(join(tempRoot, "missing-fd-executable"), [], { stdio: ["ignore", "pipe", "pipe"] });
			child.once("close", () => { closed = true; });
			return child;
		}) as unknown as typeof spawn);
		try {
			const def = createFindToolDefinition(tempRoot);
			await expect(
				def.execute(
					"spawn-error",
					{ pattern: "src/**/*.spec.ts" },
					undefined,
					undefined,
					{} as Parameters<typeof def.execute>[4],
				),
			).rejects.toThrow("Failed to run fd:");
			expect(closed).toBe(true);
		} finally {
			vi.mocked(spawn).mockImplementation(actual.spawn);
		}
	});

	for (const phase of ["validation", "listing"] as const) {
		it.skipIf(process.platform !== "win32")(`cancellation awaits owned ${phase} child close`, async () => {
			const actual = await vi.importActual<typeof import("child_process")>("child_process");
			const controller = new AbortController();
			let calls = 0;
			let closed = false;
			vi.mocked(spawn).mockImplementation(((...args: Parameters<typeof spawn>) => {
				const child = actual.spawn(...args);
				calls++;
				if (calls === (phase === "validation" ? 1 : 2)) {
					child.once("spawn", () => controller.abort());
					child.once("close", () => { closed = true; });
				}
				return child;
			}) as typeof spawn);
			try {
				const def = createFindToolDefinition(tempRoot);
				await expect(
					def.execute("abort", { pattern: "src/**/*.spec.ts" }, controller.signal, undefined, {} as any),
				).rejects.toThrow("Operation aborted");
				expect(closed).toBe(true);
				expect(calls).toBe(phase === "validation" ? 1 : 2);
			} finally {
				vi.mocked(spawn).mockImplementation(actual.spawn);
			}
		});
	}
});
