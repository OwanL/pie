import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const version: string = require("typescript/package.json").version;
const maxSourceBytes = 2 * 1024 * 1024;
const positive = "export default () => __filename;";
const negative = "export default () => require(variable);";
const policy = (value: string) =>
	`v3:${value}:esbuild=0.28.1:node22:treeShaking=false:ignoreAnnotations:keepNames:splitting=false:node/import:main`;
const hash = (code: string | null) => createHash("sha256").update(JSON.stringify(code)).digest("hex");

// Native type stripping keeps the child free of test runners/loaders that might load TypeScript themselves.
describe("compiled source provenance cache in fresh processes", () => {
	let root: string;
	let filename: string;
	let script: string;
	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "pi-compiled-source-cache-test-"));
		filename = path.join(root, "entry.ts");
		script = path.join(root, "probe.mjs");
		await writeFile(
			script,
			`
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { rewriteCompiledSource } from ${JSON.stringify(new URL("../src/core/extensions/compiled-source.ts", import.meta.url).href)};
const require = createRequire(${JSON.stringify(import.meta.url)});
const compiler = require.resolve('typescript');
const before = Boolean(require.cache[compiler]);
let writes = 0;
const writeFile = fs.writeFile;
fs.writeFile = (...args) => { writes++; return writeFile(...args); };
syncBuiltinESMExports();
const bytes = await fs.readFile(process.argv[3]);
const start = performance.now();
const code = await rewriteCompiledSource(process.argv[2], bytes);
console.log(JSON.stringify({ before, loaded: Boolean(require.cache[compiler]), writes, code: code ?? null, elapsedMs: performance.now() - start }));
`,
		);
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	function key(text: string, name = filename, metadataVersion = version) {
		return createHash("sha256")
			.update(policy(metadataVersion))
			.update("\0")
			.update(name)
			.update("\0")
			.update(Buffer.from(text))
			.digest("hex");
	}
	function cachePath(text: string, name = filename, metadataVersion = version) {
		return path.join(root, "pi-extension-provenance-v1", `${key(text, name, metadataVersion)}.json`);
	}
	async function seed(text: string, code: string | null) {
		const file = cachePath(text);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify({ key: key(text), code, hash: hash(code) }));
		await utimes(file, 1000, 1000);
		return file;
	}
	async function probe(text: string, name = filename, preload?: string) {
		const bytesFile = path.join(root, "bytes.txt");
		await writeFile(bytesFile, text);
		return JSON.parse(
			execFileSync(process.execPath, [...(preload ? ["--require", preload] : []), script, name, bytesFile], {
				encoding: "utf8",
				timeout: 15000,
				env: { ...process.env, NODE_OPTIONS: "", TEMP: root, TMP: root, TMPDIR: root },
			}),
		) as { before: boolean; loaded: boolean; writes: number; code: string | null; elapsedMs: number };
	}

	it.each(["positive", "negative"])("valid %s hits neither load the compiler nor write", async (kind) => {
		const text = kind === "positive" ? positive : negative;
		const code = kind === "positive" ? `export default () => ${JSON.stringify(filename.replace(/\\/g, "/"))};` : null;
		const file = await seed(text, code);
		const contents = await readFile(file, "utf8");
		const metadata = await stat(file);
		const result = await probe(text);
		expect(result).toMatchObject({ before: false, loaded: false, writes: 0, code });
		expect(await readFile(file, "utf8")).toBe(contents);
		expect((await stat(file)).mtimeMs).toBe(metadata.mtimeMs);
	});

	it("changed bytes with identical source size and timestamp force parsing", async () => {
		const original = "export default () => 'a';";
		const changed = "export default () => 'b';";
		await seed(original, original);
		await writeFile(filename, original);
		await utimes(filename, 1000, 1000);
		const metadata = await stat(filename);
		await writeFile(filename, changed);
		await utimes(filename, 1000, 1000);
		expect((await stat(filename)).size).toBe(metadata.size);
		expect((await stat(filename)).mtimeMs).toBe(metadata.mtimeMs);
		expect(await probe(await readFile(filename, "utf8"))).toMatchObject({
			before: false,
			loaded: true,
			writes: 1,
			code: changed,
		});
	});

	it.each(["json", "key", "hash", "code", "oversize", "unavailable"])(
		"a %s cache miss reparses safely",
		async (fault) => {
			const text = "export default () => 42;";
			const file = await seed(text, text);
			if (fault === "unavailable") {
				await rm(path.dirname(file), { recursive: true });
				await writeFile(path.dirname(file), "not a directory");
			} else {
				const entry = { key: key(text), code: text as unknown, hash: hash(text) };
				if (fault === "key") entry.key = "wrong";
				if (fault === "hash") entry.hash = hash("wrong");
				if (fault === "code") entry.code = 42;
				await writeFile(
					file,
					fault === "json"
						? "{"
						: fault === "oversize"
							? " ".repeat(maxSourceBytes * 2) + JSON.stringify(entry)
							: JSON.stringify(entry),
				);
			}
			expect(await probe(text)).toMatchObject({ before: false, loaded: true, code: text });
			if (fault !== "unavailable") {
				expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ key: key(text), code: text, hash: hash(text) });
			}
		},
	);

	it("metadata version changes invalidate the policy without modifying installed dependencies", async () => {
		const text = "export default () => 42;";
		const oldFile = await seed(text, "stale");
		const preload = path.join(root, "metadata.cjs");
		const nextVersion = `${version}-test`;
		await writeFile(
			preload,
			`const {createRequire} = require('node:module');
const scoped = createRequire(${JSON.stringify(import.meta.url)});
const metadata = scoped.resolve('typescript/package.json');
scoped(metadata);
require.cache[metadata].exports = {...require.cache[metadata].exports, version: ${JSON.stringify(nextVersion)}};
`,
		);
		expect(await probe(text, filename, preload)).toMatchObject({
			before: false,
			loaded: true,
			writes: 1,
			code: text,
		});
		expect(JSON.parse(await readFile(cachePath(text, filename, nextVersion), "utf8"))).toEqual({
			key: key(text, filename, nextVersion),
			code: text,
			hash: hash(text),
		});
		expect(JSON.parse(await readFile(oldFile, "utf8")).code).toBe("stale");
	});

	it("different filenames do not reuse provenance literals", async () => {
		await seed(positive, "stale filename");
		const other = path.join(root, "other.ts");
		expect(await probe(positive, other)).toMatchObject({
			before: false,
			loaded: true,
			code: `export default () => ${JSON.stringify(other.replace(/\\/g, "/"))};`,
		});
	});

	it("oversize source remains a no-parser, no-write fallback", async () => {
		expect(await probe(" ".repeat(maxSourceBytes + 1))).toMatchObject({
			before: false,
			loaded: false,
			writes: 0,
			code: null,
		});
	});
});
