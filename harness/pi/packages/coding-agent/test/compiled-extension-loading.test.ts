import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti/static";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareCompiledExtensions } from "../src/core/extensions/compiled-loader.ts";
import { rewriteCompiledSource } from "../src/core/extensions/compiled-source.ts";
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

	async function jitiValue(entry: string) {
		const factory = await createJiti(import.meta.url, { moduleCache: false }).import<(data: ExtensionAPI) => void>(
			entry,
			{ default: true },
		);
		let captured: unknown;
		await factory({
			appendEntry: (_key: string, data: unknown) => {
				captured = data;
			},
		} as ExtensionAPI);
		return captured;
	}

	it.each(["relative", "absolute"])("matches Jiti .ts before .tsx substitution for %s .js imports", async (kind) => {
		const helper = await source("helper.ts", "export default 'ts-first';");
		await source("helper.tsx", "export default 'tsx-second';");
		const specifier = kind === "relative" ? "./helper.js" : helper.slice(0, -3).replace(/\\/g, "/") + ".js";
		const entry = await source(
			"entry.ts",
			`import helper from ${JSON.stringify(specifier)}; export default pi => pi.appendEntry('test', helper);`,
		);
		expect(await jitiValue(entry)).toBe("ts-first");
		expect(await value(await prepare([entry]), entry)).toBe(await jitiValue(entry));
	});

	it.each(["relative", "absolute"])("falls back before evaluation for %s .js imports with only .tsx", async (kind) => {
		const helper = await source("helper.tsx", "throw Error('must not evaluate tsx'); export default 'tsx-only';");
		const specifier = kind === "relative" ? "./helper.js" : helper.slice(0, -4).replace(/\\/g, "/") + ".js";
		const entry = await source(
			"entry.ts",
			`import helper from ${JSON.stringify(specifier)}; throw Error('must not evaluate entry'); export default () => helper;`,
		);
		const good = await source("good.ts", "export default pi => pi.appendEntry('test', 'compiler-used');");
		const pass = await prepare([entry, good]);
		expect(pass.load(entry)).toBeUndefined();
		// Original Jiti rejects .tsx-only substitution rather than evaluating either source.
		await expect(jitiValue(entry)).rejects.toThrow(/Cannot find module/);
		expect(await value(pass, good)).toBe("compiler-used");
	});

	it.each(["file", "directory-index", "directory-package"])(
		"keeps existing .js %s ahead of substituted TS via Jiti fallback",
		async (kind) => {
			await source("helper.ts", "export default 'wrong-ts';");
			await source("helper.tsx", "export default 'wrong-tsx';");
			if (kind === "file") await source("helper.js", "module.exports = 'real-js';");
			else if (kind === "directory-index") await source("helper.js/index.ts", "export default 'js-directory';");
			else {
				await source("helper.js/package.json", JSON.stringify({ main: "./main.ts" }));
				await source("helper.js/main.ts", "export default 'js-directory';");
			}
			const entry = await source(
				"entry.ts",
				"import helper from './helper.js'; export default pi => pi.appendEntry('test', helper);",
			);
			const good = await source("good.ts", "export default pi => pi.appendEntry('test', 'good');");
			const pass = await prepare([entry, good]);
			expect(pass.load(entry)).toBeUndefined();
			expect(await jitiValue(entry)).toBe(kind === "file" ? "real-js" : "js-directory");
			expect(await value(pass, good)).toBe("good");
		},
	);

	it("falls back before evaluation when Jiti prefers appended .js.ts over replacement .ts", async () => {
		await source("helper.js.ts", "export default 'appended-ts';");
		await source("helper.ts", "throw Error('must not evaluate replacement'); export default 'replacement-ts';");
		const entry = await source(
			"entry.ts",
			"import helper from './helper.js'; export default pi => pi.appendEntry('test', helper);",
		);
		const good = await source("good.ts", "export default pi => pi.appendEntry('test', 'compiler-used');");
		const pass = await prepare([entry, good]);
		expect(pass.load(entry)).toBeUndefined();
		expect(await value(pass, good)).toBe("compiler-used");
		expect(await jitiValue(entry)).toBe("appended-ts");
	});

	it("preserves whole-batch sibling fallback when a .js path cannot resolve", async () => {
		const bad = await source("bad.ts", "import helper from './missing.js'; export default () => helper;");
		const good = await source("good.ts", "throw Error('must not evaluate'); export default () => {};");
		await expect(jitiValue(bad)).rejects.toThrow();
		const pass = await prepare([bad, good]);
		expect(pass.load(bad)).toBeUndefined();
		expect(pass.load(good)).toBeUndefined();
	});

	it("reads fresh TS graphs including .js specifiers, but falls back when an actual .js appears", async () => {
		await source("helper.ts", "export default 'old'");
		await source("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { conditional: ["./wrong.ts"] } } }));
		await source("wrong.ts", "export default 'wrong'");
		await source(
			"node_modules/conditional/package.json",
			JSON.stringify({ exports: { import: "./import.ts", require: "./require.ts" } }),
		);
		await source("node_modules/conditional/import.ts", "export default 'import'");
		await source("node_modules/conditional/require.ts", "module.exports = 'require'");
		const entry = await source(
			"entry.ts",
			"import helper from './helper.js'; import condition from 'conditional'; export default pi => pi.appendEntry('test', [helper, condition])",
		);
		expect(await value(await prepare([entry]), entry)).toEqual(["old", "import"]);
		await source("helper.ts", "export default 'changed'");
		expect(await value(await prepare([entry]), entry)).toEqual(["changed", "import"]);
		await source("helper.js", "export default 'new-js'");
		expect((await prepare([entry])).load(entry)).toBeUndefined();
		const factory = await createJiti(import.meta.url, { moduleCache: false }).import<(data: ExtensionAPI) => void>(
			entry,
			{ default: true },
		);
		let result: unknown;
		await factory({
			appendEntry: (_key: string, data: unknown) => {
				result = data;
			},
		} as ExtensionAPI);
		expect(result).toEqual(["new-js", "import"]);
	});

	it("stops at ESM-package native dependencies without aborting an independent TS root", async () => {
		await source("package.json", JSON.stringify({ type: "module" }));
		await source(
			"node_modules/native-package/package.json",
			JSON.stringify({ type: "module", exports: "./index.js" }),
		);
		await source(
			"node_modules/native-package/index.js",
			"throw Error('must not evaluate'); export default 1; export const named = 2;",
		);
		await source("relative.mjs", "throw Error('must not evaluate'); export default 3; export const named = 4;");
		await source(
			"bridge.ts",
			"import native, {named} from 'native-package'; import relative, {named as other} from './relative.mjs'; export const result = [native, named, relative, other];",
		);
		const consumer = await source(
			"consumer.ts",
			"throw Error('must not evaluate'); import {result} from './bridge'; export default () => result;",
		);
		const good = await source("good.ts", "export default pi => pi.appendEntry('test', 'compiler-used');");
		const pass = await prepare([consumer, good]);
		expect(pass.load(consumer)).toBeUndefined();
		expect(await value(pass, good)).toBe("compiler-used");
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
		"try {} catch (__dirname) {} export default () => {}",
		"try {} catch ({value: __filename}) {} export default () => {}",
		"import {value as __dirname} from './names'; export default () => __dirname",
		"import {value as __filename} from './names'; export default () => __filename",
		"export default () => { ({value: __dirname} = {}); }",
		"export default () => { ({__filename} = {}); }",
		"export default () => { ([__dirname] = []); }",
		"export default () => { ({nested: [__filename]} = {}); }",
		"export default () => { ([...__filename] = []); }",
		"export default () => { ({...__dirname} = {}); }",
		"export default () => { ([__dirname = 'default'] = []); }",
		"export default () => { __dirname++; }",
		"export default () => { --__filename; }",
		"export default () => { __dirname += 'suffix'; }",
		"export default () => { (__filename) = 'changed'; }",
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
		await source("names.ts", "export const value = 'imported'");
		const helper = await source("helper.ts", `throw Error('must not evaluate'); ${text}`);
		expect(await rewriteCompiledSource(helper, Buffer.from(text))).toBeUndefined();
		const entry = await source("entry.ts", "import helper from './helper'; export default helper");
		const supported = await source("supported.ts", "export default pi => pi.appendEntry('test', 'ok')");
		const pass = await prepare([entry, supported]);
		expect(pass.load(entry)).toBeUndefined();
		expect(await value(pass, supported)).toBe("ok");
	});

	it.each(["missing", "invalid"])(
		"does not traverse %s dependencies of unsupported TS roots or helpers",
		async (dependency) => {
			await source("package.json", JSON.stringify({ type: "module" }));
			if (dependency === "invalid") await source("discarded.ts", "export default = broken;");
			const unsupported = await source(
				"unsupported.ts",
				"import discarded from './discarded'; export default () => [import.meta.resolve('./other'), discarded];",
			);
			const consumer = await source("consumer.ts", "import helper from './unsupported.ts'; export default helper;");
			const unsupportedCjs = await source(
				"unsupported.cts",
				"const discarded = require('./discarded'); module.exports = () => [require.resolve('./other'), discarded];",
			);
			const cjsConsumer = await source(
				"cjs-consumer.ts",
				"import helper from './unsupported.cts'; export default helper;",
			);
			const supported = await source("supported.ts", "export default pi => pi.appendEntry('test', 'ok');");
			const pass = await prepare([unsupported, consumer, unsupportedCjs, cjsConsumer, supported]);
			for (const entry of [unsupported, consumer, unsupportedCjs, cjsConsumer])
				expect(pass.load(entry)).toBeUndefined();
			expect(await value(pass, supported)).toBe("ok");
		},
	);

	it("preserves aliased imported names, destructuring keys and ordinary assignment properties", async () => {
		// Keep the provider external: its exported binding is itself intentionally unsupported.
		const names = await source(
			"names.ts",
			"export const __dirname = 'imported-dir'; export const __filename = 'imported-file'",
		);
		const text =
			"import {__dirname as dir, __filename as file} from 'names'; const object = {__dirname: 'property', __filename: 'file'}; const {__dirname: key} = object; let assigned; ({__filename: assigned} = object); object.__dirname = 'updated'; export default pi => pi.appendEntry('test', [dir, file, key, assigned, object.__dirname, object.__filename])";
		const entry = await source("properties.ts", text);
		expect(await rewriteCompiledSource(entry, Buffer.from(text))).toBe(text);
		expect(await value(await prepare([entry], { names }), entry)).toEqual([
			"imported-dir",
			"imported-file",
			"property",
			"file",
			"updated",
			"file",
		]);
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

	it("selects pre-evaluation fallback for JSON and CJS graphs including CJS roots", async () => {
		await source("data.json", '{"value":3}');
		await source("helper.cjs", "exports.named = 4");
		const named = await source(
			"named.ts",
			"import {named} from './helper.cjs'; export default pi => pi.appendEntry('test', named)",
		);
		expect((await prepare([named])).load(named)).toBeUndefined();
		const plain = await source("plain.cjs", "module.exports = pi => pi.appendEntry('test', 5)");
		expect((await prepare([plain])).load(plain)).toBeUndefined();
		const entry = await source(
			"entry.cts",
			"const data = require('./data.json'); const {named} = require('./helper.cjs'); module.exports = {__esModule: true, default: {default: pi => pi.appendEntry('test', data.value + named)}}",
		);
		expect((await prepare([entry])).load(entry)).toBeUndefined();
		const jsonOnly = await source("json-only.ts", "import data from './data.json'; export default () => data");
		expect((await prepare([jsonOnly])).load(jsonOnly)).toBeUndefined();
		for (const [filename, expected] of [
			[named, 4],
			[plain, 5],
			[entry, 7],
		] as const) {
			const factory = await createJiti(import.meta.url, { moduleCache: false }).import<(data: ExtensionAPI) => void>(
				filename,
				{ default: true },
			);
			expect(factory).toBeTypeOf("function");
			let captured: unknown;
			await factory({
				appendEntry: (_key: string, data: unknown) => {
					captured = data;
				},
			} as ExtensionAPI);
			expect(captured).toBe(expected);
		}
	});

	it("matches fresh Jiti CJS singleton identity and state across multiple entries", async () => {
		await source("singleton.cjs", "module.exports = { count: 0 }");
		const entries = await Promise.all(
			["first.cjs", "second.cjs"].map((name) =>
				source(
					name,
					"const singleton = require('./singleton.cjs'); module.exports = pi => pi.appendEntry('test', [singleton, ++singleton.count])",
				),
			),
		);
		const script = await source(
			"singleton.mjs",
			`
			import {createJiti} from ${JSON.stringify(pathToFileURL(path.join(path.dirname(createRequire(import.meta.url).resolve("jiti/package.json")), "lib/jiti-static.mjs")).href)};
			import {prepareCompiledExtensions} from ${JSON.stringify(new URL("../src/core/extensions/compiled-loader.ts", import.meta.url).href)};
			const entries = ${JSON.stringify(entries)};
			async function capture(load) {
				const results = [];
				for (const entry of entries) {
					const factory = await load(entry);
					await factory({appendEntry(key, result) { results.push(result); }});
				}
				const counts = results.map(result => result[1]);
				results[0][0].count = 0;
				return [results[0][0] === results[1][0], counts];
			}
			const jiti = await capture(entry => createJiti(import.meta.url, {moduleCache: false}).import(entry, {default: true}));
			const pass = await prepareCompiledExtensions(entries, {});
			try {
				const fallback = entries.map(entry => pass.load(entry) === undefined);
				if (!fallback.every(Boolean)) throw Error('native roots must fall back');
				const compiled = await capture(entry => pass.load(entry) ?? createJiti(import.meta.url, {moduleCache: false}).import(entry, {default: true}));
				console.log(JSON.stringify({jiti, compiled}));
			} finally { await pass.dispose(); }
		`,
		);
		const result = JSON.parse(execFileSync(process.execPath, [script], { encoding: "utf8", timeout: 10000 }));
		expect(result.jiti).toEqual([true, [1, 2]]);
		expect(result.compiled).toEqual(result.jiti);
	});

	it.each(["js", "mjs", "cjs", "json"])(
		"rejects actual .%s roots and consuming roots before evaluation",
		async (extension) => {
			const native = await source(
				`native.${extension}`,
				extension === "json" ? '{"value":1}' : "throw Error('must not evaluate');",
			);
			await source("bridge.ts", `import './native.${extension}'; export const value = 1;`);
			const entry = await source("consumer.ts", "import {value} from './bridge'; export default () => value;");
			const supported = await source("supported.ts", "export default pi => pi.appendEntry('test', 'ok');");
			const pass = await prepare([native, entry, supported]);
			expect(pass.load(native)).toBeUndefined();
			expect(pass.load(entry)).toBeUndefined();
			expect(await value(pass, supported)).toBe("ok");
		},
	);

	it.each([
		"JITI_NATIVE_MODULES",
		"JITI_TRANSFORM_MODULES",
		"JITI_ALIAS",
		"JITI_TRY_NATIVE",
		"JITI_MODULE_CACHE",
		"jiti_alias",
	])("keeps original Jiti policy when %s is overridden", async (key) => {
		const previous = process.env[key];
		process.env[key] = key === "JITI_ALIAS" ? "{}" : key.endsWith("MODULES") ? "[]" : "false";
		try {
			const entry = await source("override.ts", "throw Error('must not evaluate'); export default () => {};");
			expect((await prepare([entry])).load(entry)).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		}
	});

	it("shares native constructors and mutable JSON across the host and mixed compiled/fallback roots", async () => {
		const native = await source("native.cjs", "exports.Constructor = class Constructor {};");
		const json = await source("shared.json", '{"count":0}');
		const compiled = await source(
			"compiled.ts",
			"const {Constructor} = require('host-native'); const data = require('host-json'); export default pi => pi.appendEntry('test', [Constructor, new Constructor(), data, ++data.count]);",
		);
		const fallback = await source(
			"fallback.ts",
			"const {Constructor} = require('./native.cjs'); const data = require('./shared.json'); export default pi => pi.appendEntry('test', [Constructor, new Constructor(), data, ++data.count]);",
		);
		const script = await source(
			"mixed.mjs",
			`
			import {createRequire} from 'node:module';
			import {createJiti} from ${JSON.stringify(pathToFileURL(path.join(path.dirname(createRequire(import.meta.url).resolve("jiti/package.json")), "lib/jiti-static.mjs")).href)};
			import {prepareCompiledExtensions} from ${JSON.stringify(new URL("../src/core/extensions/compiled-loader.ts", import.meta.url).href)};
			const require = createRequire(import.meta.url);
			const host = require(${JSON.stringify(native)});
			const data = require(${JSON.stringify(json)});
			const entries = ${JSON.stringify([compiled, fallback])};
			const pass = await prepareCompiledExtensions(entries, ${JSON.stringify({ "host-native": native, "host-json": json })});
			try {
				if (pass.load(entries[1]) !== undefined) throw Error('expected fallback');
				const compiledFactory = pass.load(entries[0]);
				if (!compiledFactory) throw Error('expected compiled root');
				const results = [];
				for (const factory of [await compiledFactory, await createJiti(import.meta.url, {moduleCache: false}).import(entries[1], {default: true})]) {
					await factory({appendEntry(key, result) { results.push(result); }});
				}
				console.log(JSON.stringify([results.map(result => [result[0] === host.Constructor, result[1] instanceof host.Constructor, result[2] === data, result[3]]), data.count]));
			} finally { await pass.dispose(); }
		`,
		);
		expect(JSON.parse(execFileSync(process.execPath, [script], { encoding: "utf8", timeout: 10000 }))).toEqual([
			[
				[true, true, true, 1],
				[true, true, true, 2],
			],
			2,
		]);
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
