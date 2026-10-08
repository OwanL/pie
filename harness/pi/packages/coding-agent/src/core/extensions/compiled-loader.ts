import { statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { importCompiledFactory, rewriteCompiledSource } from "./compiled-source.ts";
import type { ExtensionFactory } from "./types.ts";

export interface CompiledExtensions {
	/** Undefined means pre-evaluation fallback. A rejected promise must never be retried with Jiti. */
	load(path: string): Promise<ExtensionFactory> | undefined;
	/** Caller must finish invoking all registrations before disposal. */
	dispose(): Promise<void>;
}

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const extensions = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx"];
let buildQueue: Promise<void> = Promise.resolve();

function fileExists(filename: string): boolean {
	try {
		return statSync(filename).isFile();
	} catch {
		return false;
	}
}

/**
 * Opt-in Node compiler for one-use inventory only, not general reload/session loading.
 * No module/factory/graph cache. Each pass resolves and reads the complete source graph.
 * Alias paths are authoritative caller-verified SDK bytes; never bundle another SDK.
 */
export async function prepareCompiledExtensions(
	paths: readonly string[],
	aliases: Record<string, string>,
): Promise<CompiledExtensions> {
	const files = new Map<string, { url: string; commonJS: boolean }>();
	let root: string | undefined;
	let disposed = false;
	const pass: CompiledExtensions = {
		load(filename) {
			if (disposed) throw new Error("Compiled extensions already disposed");
			const output = files.get(path.resolve(filename));
			return output ? importCompiledFactory(output.url, output.commonJS) : undefined;
		},
		async dispose() {
			disposed = true;
			files.clear();
			if (root) await rm(root, { recursive: true, force: true });
		},
	};
	if (!paths.length || "Bun" in globalThis) return pass;
	const entries = [...new Set(paths.map((entry) => path.resolve(entry)))];
	const previous = buildQueue;
	let release: () => void = () => {};
	buildQueue = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		if (esbuild.version !== "0.28.1" || entries.length > 512) return pass;
		for (const target of Object.values(aliases)) if (!path.isAbsolute(target) || !fileExists(target)) return pass;
		root = await mkdtemp(path.join(tmpdir(), "pi-compiled-extensions-"));
		const unsupported = new Set<string>();
		let sourceBytes = 0;
		let inputCount = 0;
		const result = await esbuild.build({
			entryPoints: entries.map((entry, index) => ({ in: entry, out: `entry-${index}` })),
			outdir: root,
			outExtension: { ".js": ".mjs" },
			bundle: true,
			splitting: false,
			platform: "node",
			format: "esm",
			target: "node22",
			treeShaking: false,
			ignoreAnnotations: true,
			keepNames: true,
			conditions: ["node", "import"],
			mainFields: ["main"],
			resolveExtensions: extensions,
			// Empty raw config disables automatic tsconfig paths/baseUrl discovery.
			tsconfigRaw: {},
			nodePaths: [],
			write: false,
			metafile: true,
			logLevel: "silent",
			plugins: [
				{
					name: "jiti-resolution-and-source-provenance",
					setup(build) {
						build.onResolve({ filter: /.*/ }, (args) => {
							const nativePath = (filename: string) =>
								args.kind === "require-call" ? filename.replace(/\\/g, "/") : pathToFileURL(filename).href;
							if (Object.hasOwn(aliases, args.path))
								return { path: nativePath(aliases[args.path]), external: true };
							if (builtins.has(args.path) || args.path.startsWith("node:"))
								return { path: args.path, external: true };
							if (
								/^(?:@earendil-works\/|@mariozechner\/|typebox(?:\/|$)|@sinclair\/typebox(?:\/|$))/.test(
									args.path,
								)
							) {
								unsupported.add(path.resolve(args.importer));
								return { path: args.path, external: true };
							}
							if (/^(jiti|typescript)(\/|$)/.test(args.path))
								return {
									path: nativePath(createRequire(args.importer || entries[0]).resolve(args.path)),
									external: true,
								};
							if (args.path.endsWith(".node") || /^(?:data:|https?:|file:)/.test(args.path)) {
								unsupported.add(path.resolve(args.importer));
								return { path: args.path, external: true };
							}
							// Jiti tries the exact path before TS substitution; esbuild does the reverse.
							if (args.path.startsWith(".") || path.isAbsolute(args.path)) {
								const exact = path.resolve(args.resolveDir, args.path);
								if (fileExists(exact)) return { path: exact };
							}
							return undefined;
						});
						build.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
							if (++inputCount > 4096 || statSync(args.path).size > 2 * 1024 * 1024)
								throw new Error("Compiler input budget exceeded");
							const source = await readFile(args.path);
							sourceBytes += source.byteLength;
							if (sourceBytes > 64 * 1024 * 1024) throw new Error("Compiler source budget exceeded");
							if (args.path.endsWith(".json")) return { contents: source, loader: "json" };
							if (!extensions.includes(path.extname(args.path))) throw new Error("Unsupported compiler input");
							const rewritten = await rewriteCompiledSource(args.path, source);
							if (rewritten === undefined) unsupported.add(path.resolve(args.path));
							const loader = /\.[cm]?tsx$/.test(args.path) ? "tsx" : /\.[cm]?ts$/.test(args.path) ? "ts" : "js";
							return { contents: rewritten ?? source, loader };
						});
					},
				},
			],
		});
		const inputs = new Map(
			Object.entries(result.metafile.inputs).map(([input, metadata]) => [path.resolve(input), metadata]),
		);
		for (const warning of result.warnings) {
			if (!warning.location) throw new Error("Unattributed compiler warning");
			unsupported.add(path.resolve(warning.location.file));
		}
		function supportedGraph(entry: string, visited = new Set<string>()): boolean {
			if (unsupported.has(entry)) return false;
			if (visited.has(entry)) return true;
			visited.add(entry);
			const input = inputs.get(entry);
			if (!input) return false;
			return input.imports.every((edge) => edge.external || supportedGraph(path.resolve(edge.path), visited));
		}
		for (const output of result.outputFiles) {
			const metadata = result.metafile.outputs[path.relative(process.cwd(), output.path).replace(/\\/g, "/")];
			if (!metadata?.entryPoint) throw new Error("Missing compiled entry metadata");
			const entry = path.resolve(metadata.entryPoint);
			if (!supportedGraph(entry)) continue;
			const banner = `import { createRequire as __piCompiledCreateRequire } from 'node:module'; const require = __piCompiledCreateRequire(${JSON.stringify(pathToFileURL(entry).href)});\n`;
			await writeFile(output.path, banner + output.text, { mode: 0o600 });
			files.set(entry, { url: pathToFileURL(output.path).href, commonJS: inputs.get(entry)?.format === "cjs" });
		}
	} catch {
		// Batch compile/resolution/IO failures select original fresh Jiti before any evaluation.
		files.clear();
		if (root) {
			await rm(root, { recursive: true, force: true });
			root = undefined;
		}
	} finally {
		try {
			await esbuild.stop();
		} finally {
			release();
		}
	}
	return pass;
}
