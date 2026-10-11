import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearExtensionCache, loadExtensionsCached } from "../src/core/extensions/loader.ts";
import type { ExtensionAPI, ExtensionFactory } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const compiler = vi.hoisted(() => ({
	prepare: vi.fn(),
	load: vi.fn(),
	dispose: vi.fn(),
	jitiImport: vi.fn(),
}));
vi.mock("../src/core/extensions/compiled-loader.ts", () => ({ prepareCompiledExtensions: compiler.prepare }));
vi.mock("jiti/static", () => ({ createJiti: () => ({ import: compiler.jitiImport }) }));

describe("compiled inventory integration", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	const order: string[] = [];
	function entry(name: string, dir = root): string {
		mkdirSync(dir, { recursive: true });
		const filename = join(dir, `${name}.ts`);
		writeFileSync(filename, "export default () => {};");
		return filename;
	}
	function factory(name: string): ExtensionFactory {
		return async (pi: ExtensionAPI) => {
			await Promise.resolve();
			order.push(name);
			pi.registerFlag(name, { type: "boolean", default: true });
		};
	}
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-inventory-loader-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		clearExtensionCache();
		vi.clearAllMocks();
		order.length = 0;
		compiler.dispose.mockResolvedValue(undefined);
		compiler.prepare.mockResolvedValue({ load: compiler.load, dispose: compiler.dispose });
		compiler.load.mockImplementation((filename: string) => Promise.resolve(factory(filename)));
		compiler.jitiImport.mockImplementation(async (filename: string) => factory(filename));
	});
	afterEach(() => {
		clearExtensionCache();
		rmSync(root, { recursive: true, force: true });
	});

	it("defaults to cached Jiti without preparing the compiler", async () => {
		const filename = entry("default");
		await loadExtensionsCached([filename], cwd);
		await loadExtensionsCached([filename], cwd);
		expect(compiler.prepare).not.toHaveBeenCalled();
		expect(compiler.jitiImport).toHaveBeenCalledTimes(1);
		expect(order).toEqual([filename, filename]);
	});

	it("bypasses existing cache without replacing it, and disposes each pass after registration", async () => {
		const filename = entry("fresh");
		await loadExtensionsCached([filename], cwd);
		compiler.dispose.mockImplementation(async () => {
			expect(order.at(-1)).toBe(filename);
		});
		for (let index = 0; index < 2; index++) {
			const result = await loadExtensionsCached([filename], cwd, undefined, undefined, "compiled-inventory");
			expect(result.extensions[0].flags.has(filename)).toBe(true);
		}
		await loadExtensionsCached([filename], cwd);
		expect(compiler.prepare).toHaveBeenCalledTimes(2);
		expect(compiler.load).toHaveBeenCalledTimes(2);
		expect(compiler.dispose).toHaveBeenCalledTimes(2);
		expect(compiler.jitiImport).toHaveBeenCalledTimes(1);
	});

	it("keeps sequential diagnostics and falls back only for synchronous undefined", async () => {
		const paths = ["good", "fallback", "evaluation", "invalid", "registration", "last"].map((name) => entry(name));
		compiler.load.mockImplementation((filename: string) => {
			if (filename === paths[1]) return undefined;
			if (filename === paths[2]) return Promise.reject(new Error("evaluation failed"));
			if (filename === paths[3]) return Promise.resolve(undefined);
			if (filename === paths[4])
				return Promise.resolve(() => {
					throw new Error("registration failed");
				});
			return Promise.resolve(factory(filename));
		});
		const result = await loadExtensionsCached(paths, cwd, undefined, undefined, "compiled-inventory");
		expect(order).toEqual([paths[0], paths[1], paths[5]]);
		expect(result.extensions.map((extension) => extension.path)).toEqual(order);
		expect(result.errors.map((error) => error.path)).toEqual(paths.slice(2, 5));
		expect(result.errors[0].error).toContain("evaluation failed");
		expect(result.errors[1].error).toContain("valid factory");
		expect(result.errors[2].error).toContain("registration failed");
		expect(compiler.jitiImport.mock.calls.map((call) => call[0])).toEqual([paths[1]]);
		expect(compiler.dispose).toHaveBeenCalledTimes(1);
	});

	it("does not import a compiler for empty inventories or Bun", async () => {
		await loadExtensionsCached([], cwd, undefined, undefined, "compiled-inventory");
		vi.stubGlobal("Bun", {});
		try {
			await loadExtensionsCached([entry("bun")], cwd, undefined, undefined, "compiled-inventory");
		} finally {
			vi.unstubAllGlobals();
		}
		expect(compiler.prepare).not.toHaveBeenCalled();
		expect(compiler.jitiImport).toHaveBeenCalledTimes(1);
	});

	it("opts in for ordinary reload, trust bootstrap, and remaining post-trust paths", async () => {
		const globalEntry = entry("global", join(agentDir, "extensions"));
		const projectEntry = entry("project", join(cwd, ".pi", "extensions"));
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionLoading: "compiled-inventory",
		});
		await loader.reload();
		expect(compiler.prepare).toHaveBeenCalledTimes(1);
		expect(compiler.prepare.mock.calls[0][0]).toContain(resolve(globalEntry));
		compiler.prepare.mockClear();
		compiler.load.mockClear();
		await loader.reload({ resolveProjectTrust: async () => true });
		expect(compiler.prepare).toHaveBeenCalledTimes(2);
		expect(compiler.prepare.mock.calls[0][0]).toEqual([resolve(globalEntry)]);
		expect(compiler.prepare.mock.calls[1][0]).toEqual([resolve(projectEntry)]);
		expect(compiler.load.mock.calls.map((call) => call[0])).toEqual([globalEntry, projectEntry]);
		expect(loader.getExtensions().extensions.map((extension) => extension.path)).toContain(projectEntry);
		expect(compiler.jitiImport).not.toHaveBeenCalled();
	});
});
