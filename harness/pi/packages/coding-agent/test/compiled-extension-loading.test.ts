import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareCompiledExtensions } from "../src/core/extensions/compiled-loader.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

describe("one-use compiled extension preparation", () => {
	let root: string;
	const passes: Awaited<ReturnType<typeof prepareCompiledExtensions>>[] = [];
	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "pi-compiled-test-"));
	});
	afterEach(async () => {
		await Promise.all(passes.splice(0).map((pass) => pass.dispose()));
		await rm(root, { recursive: true, force: true });
	});
	async function source(name: string, text: string) {
		const file = path.join(root, name);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, text);
		return file;
	}
	async function prepare(entries: string[], aliases: Record<string, string> = {}) {
		const pass = await prepareCompiledExtensions(entries, aliases);
		passes.push(pass);
		return pass;
	}
	async function value(pass: Awaited<ReturnType<typeof prepareCompiledExtensions>>, entry: string) {
		let captured: unknown;
		const factory = await pass.load(entry);
		expect(factory).toBeTypeOf("function");
		await factory?.({
			appendEntry: (_key: string, data: unknown) => {
				captured = data;
			},
		} as ExtensionAPI);
		return captured;
	}

	it("reads fresh transitive source and prefers a newly added actual .js; uses node/import and ignores tsconfig paths", async () => {
		await source("helper.ts", "export default 'old'");
		await source("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { conditional: ["./wrong.ts"] } } }));
		await source("wrong.ts", "export default 'wrong'");
		await source(
			"node_modules/conditional/package.json",
			JSON.stringify({ exports: { import: "./import.js", require: "./require.js" } }),
		);
		await source("node_modules/conditional/import.js", "export default 'import'");
		await source("node_modules/conditional/require.js", "module.exports = 'require'");
		const entry = await source(
			"entry.ts",
			"import helper from './helper.js'; import condition from 'conditional'; export default pi => pi.appendEntry('test', [helper, condition])",
		);
		expect(await value(await prepare([entry]), entry)).toEqual(["old", "import"]);
		await source("helper.ts", "export default 'changed'");
		expect(await value(await prepare([entry]), entry)).toEqual(["changed", "import"]);
		await source("helper.js", "export default 'new-js'");
		expect(await value(await prepare([entry]), entry)).toEqual(["new-js", "import"]);
	});

	it("rewrites per-file provenance, shorthand globals and leaves ordinary properties alone", async () => {
		const helper = await source(
			"meta.ts",
			"export const meta = [import.meta.url, import.meta.dirname, import.meta.filename, {__dirname, __filename}, {__dirname: 'property'}.__dirname]",
		);
		const entry = await source(
			"entry.ts",
			"import {meta} from './meta'; export default pi => pi.appendEntry('test', meta)",
		);
		const normalized = helper.replace(/\\/g, "/");
		expect(await value(await prepare([entry]), entry)).toEqual([
			pathToFileURL(helper).href,
			path.dirname(helper).replace(/\\/g, "/"),
			normalized,
			{ __dirname: path.dirname(helper).replace(/\\/g, "/"), __filename: normalized },
			"property",
		]);
	});

	it.each([
		"const __dirname = 'shadow'; export default () => __dirname",
		"export default function(__filename) { return __filename }",
		"const {__dirname} = {}; export default () => __dirname",
		"export default () => import.meta.resolve('./helper')",
		"export default () => import.meta",
		"export default () => require(Math.random())",
		"export default () => require.resolve('./helper')",
		"export default () => module.filename",
		"const module = {}; export default () => module",
		"const exports = {}; export default () => exports",
		"export default () => import(Math.random())",
		"function decorate(c) {} @decorate class Example {} export default () => Example",
	])("selects fallback before evaluating unsupported transitive source: %s", async (text) => {
		await source("helper.ts", `throw Error('must not evaluate'); ${text}`);
		const entry = await source("entry.ts", "import helper from './helper'; export default helper");
		const supported = await source("supported.ts", "export default pi => pi.appendEntry('test', 'ok')");
		const pass = await prepare([entry, supported]);
		expect(pass.load(entry)).toBeUndefined();
		expect(await value(pass, supported)).toBe("ok");
	});

	it("falls back for the whole batch on compile failure without evaluating good roots", async () => {
		const good = await source("good.ts", "throw Error('must not evaluate'); export default () => {};");
		const bad = await source("bad.ts", "export default = broken");
		const pass = await prepare([good, bad]);
		expect(pass.load(good)).toBeUndefined();
		expect(pass.load(bad)).toBeUndefined();
	});

	it("preserves external host constructor and singleton identity with exact aliases", async () => {
		const sdk = await source("sdk.mjs", "export class Constructor {}; export const singleton = {};");
		const entry = await source(
			"entry.ts",
			"import {Constructor, singleton} from '@earendil-works/pi-coding-agent'; export default pi => pi.appendEntry('test', [Constructor, new Constructor(), singleton])",
		);
		// Real Node child: Vitest's module runner does not share native require's registry.
		const script = await source(
			"identity.mjs",
			`
			import * as host from ${JSON.stringify(pathToFileURL(sdk).href)};
			import {prepareCompiledExtensions} from ${JSON.stringify(new URL("../src/core/extensions/compiled-loader.ts", import.meta.url).href)};
			const pass = await prepareCompiledExtensions([${JSON.stringify(entry)}], {'@earendil-works/pi-coding-agent': ${JSON.stringify(sdk)}});
			try {
				const factory = await pass.load(${JSON.stringify(entry)});
				await factory({appendEntry(key, result) { console.log(JSON.stringify([result[0] === host.Constructor, result[1] instanceof host.Constructor, result[2] === host.singleton])); }});
			} finally { await pass.dispose(); }
		`,
		);
		expect(JSON.parse(execFileSync(process.execPath, [script], { encoding: "utf8", timeout: 10000 }))).toEqual([
			true,
			true,
			true,
		]);
	});

	it("supports JSON, named CJS imports and nested CJS default factory interop", async () => {
		await source("data.json", '{"value":3}');
		await source("helper.cjs", "exports.named = 4");
		const named = await source(
			"named.ts",
			"import {named} from './helper.cjs'; export default pi => pi.appendEntry('test', named)",
		);
		expect(await value(await prepare([named]), named)).toBe(4);
		const plain = await source("plain.cjs", "module.exports = pi => pi.appendEntry('test', 5)");
		expect(await value(await prepare([plain]), plain)).toBe(5);
		const entry = await source(
			"entry.cts",
			"const data = require('./data.json'); const {named} = require('./helper.cjs'); module.exports = {__esModule: true, default: {default: pi => pi.appendEntry('test', data.value + named)}}",
		);
		expect(await value(await prepare([entry]), entry)).toBe(7);
	});

	it("bundles dynamic helpers, keeps live bindings, and reloads at a new URL after disposal", async () => {
		await source("helper.ts", "export let count = 0; export function increment() { count++ }");
		const entry = await source(
			"entry.ts",
			"import {count, increment} from './helper'; await Promise.resolve(); export default async pi => { increment(); const helper = await import('./helper'); pi.appendEntry('test', [count, helper.count]); }",
		);
		const script = await source(
			"reload.mjs",
			`
			import {prepareCompiledExtensions} from ${JSON.stringify(new URL("../src/core/extensions/compiled-loader.ts", import.meta.url).href)};
			const snapshots = [];
			for (let index = 0; index < 2; index++) {
				const pass = await prepareCompiledExtensions([${JSON.stringify(entry)}], {});
				const factory = await pass.load(${JSON.stringify(entry)});
				await factory({appendEntry(key, result) { snapshots.push(result); }});
				await pass.dispose();
				if (index === 0) await factory({appendEntry(key, result) { snapshots.push(result); }});
			}
			console.log(JSON.stringify(snapshots));
		`,
		);
		expect(JSON.parse(execFileSync(process.execPath, [script], { encoding: "utf8", timeout: 10000 }))).toEqual([
			[1, 1],
			[2, 2],
			[1, 1],
		]);
	});

	it("serializes concurrent preparation jobs without invalidating their outputs", async () => {
		const entry = await source("concurrent.ts", "export default pi => pi.appendEntry('test', 'ready')");
		const concurrent = await Promise.all([prepare([entry]), prepare([entry])]);
		expect(await Promise.all(concurrent.map((pass) => value(pass, entry)))).toEqual(["ready", "ready"]);
	});

	it("does not turn invalid evaluated exports into a Jiti fallback", async () => {
		const entry = await source("invalid.ts", "export default {default: () => {}};");
		const pass = await prepare([entry]);
		await expect(pass.load(entry)).rejects.toThrow("valid factory");
	});

	it("propagates native evaluation errors without selecting fallback or re-executing", async () => {
		const entry = await source(
			"throw.ts",
			"globalThis.compiledEvaluations = (globalThis.compiledEvaluations || 0) + 1; throw Error('native-evaluation'); export default () => {};",
		);
		const script = await source(
			"throws.mjs",
			`
			import {prepareCompiledExtensions} from ${JSON.stringify(new URL("../src/core/extensions/compiled-loader.ts", import.meta.url).href)};
			const pass = await prepareCompiledExtensions([${JSON.stringify(entry)}], {});
			const errors = [];
			try {
				for (let index = 0; index < 2; index++) {
					const promise = pass.load(${JSON.stringify(entry)});
					if (!promise) throw Error('unexpected fallback');
					try { await promise; } catch (error) { errors.push(error.message); }
				}
				console.log(JSON.stringify([errors, globalThis.compiledEvaluations]));
			} finally { await pass.dispose(); }
		`,
		);
		expect(JSON.parse(execFileSync(process.execPath, [script], { encoding: "utf8", timeout: 10000 }))).toEqual([
			["native-evaluation", "native-evaluation"],
			1,
		]);
	});
});
