import { existsSync, statSync } from "node:fs";
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
 * No module/factory/graph cache. Each pass rereads supported graphs; rejected graphs use fresh Jiti.
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
	// Ambient Jiti policy is not reproduced by the compiler. Keep the original loader
	// whenever an override could affect resolution, transformation, or native identity.
	if (!paths.length || "Bun" in globalThis || Object.keys(process.env).some((key) => /^JITI_/i.test(key))) return pass;
	const entries = [...new Set(paths.map((entry) => path.resolve(entry)))];
	const previous = buildQueue;
	let release: () => void = () => {};
	buildQueue = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		if (esbuild.version !== "0.28.1" || entries.length > 512) return pass;
		const compiledEntries = entries.filter((entry) => !(/\.(?:cjs|mjs|js|json)$/.test(entry) && fileExists(entry)));
		if (!compiledEntries.length) return pass;
		for (const target of Object.values(aliases)) if (!path.isAbsolute(target) || !fileExists(target)) return pass;
		root = await mkdtemp(path.join(tmpdir(), "pi-compiled-extensions-"));
		const unsupported = new Set<string>();
		let sourceBytes = 0;
		let inputCount = 0;
		const sources = new Map<string, Promise<string | undefined>>();
		function readSource(filename: string): Promise<string | undefined> {
			let pending = sources.get(filename);
			if (!pending) {
				pending = (async () => {
					if (++inputCount > 4096 || statSync(filename).size > 2 * 1024 * 1024)
						throw new Error("Compiler input budget exceeded");
					const source = await readFile(filename);
					sourceBytes += source.byteLength;
					if (sourceBytes > 64 * 1024 * 1024) throw new Error("Compiler source budget exceeded");
					if (!extensions.includes(path.extname(filename))) throw new Error("Unsupported compiler input");
					const rewritten = await rewriteCompiledSource(filename, source);
					if (rewritten === undefined) unsupported.add(path.resolve(filename));
					return rewritten;
				})();
				sources.set(filename, pending);
			}
			return pending;
		}
		const result = await esbuild.build({
			entryPoints: compiledEntries.map((entry, index) => ({ in: entry, out: `entry-${index}` })),
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
						const resolving = Symbol("native-boundary-resolution");
						build.onResolve({ filter: /.*/ }, async (args) => {
							if (args.pluginData === resolving) return undefined;
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
							let exact: string | undefined;
							if (args.path.startsWith(".") || path.isAbsolute(args.path)) {
								const candidate = path.resolve(args.resolveDir, args.path);
								let missing = false;
								try {
									const stats = statSync(candidate);
									if (stats.isFile()) exact = candidate;
									else if (
										stats.isDirectory() &&
										args.path.endsWith(".js") &&
										[".ts", ".tsx"].some((extension) => fileExists(candidate.slice(0, -3) + extension))
									) {
										// esbuild may substitute TS before this directory; let Jiti own it.
										unsupported.add(path.resolve(args.importer));
									}
								} catch (error) {
									missing = (error as NodeJS.ErrnoException).code === "ENOENT";
								}
								if (
									missing &&
									args.namespace === "file" &&
									/\.[cm]?tsx?$/.test(args.importer) &&
									args.path.endsWith(".js") &&
									(/^(?:\.{1,2}[/\\])/.test(args.path) || path.isAbsolute(args.path))
								) {
									// Jiti 2.7 jitiResolve first tries appended extensions, then
									// replaces .js with .ts (not .tsx). esbuild also prefers .ts.
									const replacement = candidate.slice(0, -3) + ".ts";
									if (extensions.some((extension) => existsSync(candidate + extension))) {
										// esbuild may choose TS substitution instead of Jiti's appended path.
										unsupported.add(path.resolve(args.importer));
										return { path: nativePath(candidate), external: true };
									} else {
										if (fileExists(replacement)) exact = replacement;
										else if (fileExists(candidate.slice(0, -3) + ".tsx")) {
											// Jiti cannot resolve this substitution. Discard only its consumers,
											// without parsing the unsupported target or aborting sibling roots.
											unsupported.add(path.resolve(args.importer));
											return { path: nativePath(candidate), external: true };
										}
									}
								}
							}
							const resolved: esbuild.OnResolveResult = exact
								? { path: exact, namespace: "file" }
								: await build.resolve(args.path, {
										importer: args.importer,
										namespace: args.namespace,
										resolveDir: args.resolveDir,
										kind: args.kind,
										with: args.with,
										pluginData: resolving,
									});
							if (resolved.errors?.length || resolved.external || !resolved.path) return resolved;
							if (resolved.namespace === "file" && /\.(?:cjs|mjs|js|json)$/.test(resolved.path)) {
								// Stop before parsing native modules: even inert stubs can reject ESM
								// import shapes. Every consumer of this importer falls back before evaluation.
								unsupported.add(path.resolve(args.importer));
								return { ...resolved, external: true };
							}
							if (
								args.importer &&
								resolved.namespace === "file" &&
								/\.[cm]?tsx?$/.test(resolved.path) &&
								(await readSource(resolved.path)) === undefined
							) {
								// Reject this consumer before parsing any known-discarded dependency graph.
								unsupported.add(path.resolve(args.importer));
								return { ...resolved, external: true };
							}
							return { ...resolved, pluginData: undefined };
						});
						build.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
							const rewritten = await readSource(args.path);
							const loader = /\.[cm]?tsx$/.test(args.path) ? "tsx" : /\.[cm]?ts$/.test(args.path) ? "ts" : "js";
							// Unsupported roots cannot be external entry points. Explicit ESM has no
							// import-shape ambiguity, and this marked output is never evaluated.
							return { contents: rewritten ?? "export {};", loader };
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
