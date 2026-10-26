import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("application default extensions", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	let bundled: string;
	let legacy: string;
	let counter: string;
	const globalState = globalThis as typeof globalThis & Record<string, number | undefined>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-default-extensions-"));
		cwd = join(root, "project");
		agentDir = join(root, "user");
		bundled = join(root, "bundle", "example.ts");
		legacy = join(agentDir, "extensions", "example.ts");
		counter = `__defaultExtension_${Date.now()}_${Math.random()}`;
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		factory(bundled, "bundled");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		delete globalState[counter];
		rmSync(root, { recursive: true, force: true });
	});

	function factory(path: string, name: string): void {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `export default function(pi) {
	globalThis[${JSON.stringify(counter)}] = (globalThis[${JSON.stringify(counter)}] ?? 0) + 1;
	pi.registerCommand(${JSON.stringify(name)}, { description: ${JSON.stringify(name)}, handler: async () => {} });
}`);
	}
	function settings(extensions: string[]): void {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions }));
	}
	function loader(options: Partial<ConstructorParameters<typeof DefaultResourceLoader>[0]> = {}) {
		return new DefaultResourceLoader({
			cwd, agentDir,
			defaultExtensions: [{ path: bundled, legacyPaths: ["extensions/example.ts", "legacy/example.ts"] }],
			...options,
		});
	}

	it.each([true, false])("defers fresh user-scope defaults until trust resolves to %s", async (trusted) => {
		const resources = loader({ defaultExtensions: [{
			path: bundled, legacyPaths: [], legacyPackageSources: ["npm:pi-web-access", "npm:pi-mcp-adapter"],
		}] });
		await resources.reload({ resolveProjectTrust: async ({ extensionsResult }) => {
			expect(extensionsResult.extensions).toEqual([]);
			expect(globalState[counter]).toBeUndefined();
			return trusted;
		} });
		expect(resources.getExtensions().extensions[0]).toMatchObject({
			path: bundled, sourceInfo: { source: "auto", scope: "user", origin: "top-level", baseDir: agentDir },
		});
		expect(globalState[counter]).toBe(1);
		await resources.reload();
		expect(globalState[counter]).toBe(2);
	});

	it.each(["auto", "explicit", "cli"])("evaluates only the exact %s legacy factory", async (mode) => {
		const selected = mode === "auto" ? legacy : join(agentDir, "legacy", "example.ts");
		factory(selected, "legacy");
		if (mode === "explicit") settings(["legacy/example.ts"]);
		const resources = loader(mode === "cli" ? { additionalExtensionPaths: [selected] } : {});
		await resources.reload({ resolveProjectTrust: async () => true });
		expect(resources.getExtensions().extensions.map((e) => e.path)).toEqual([selected]);
		expect(globalState[counter]).toBe(1);
	});

	it("admits project-selected exact legacy code only after trust without evaluating the bundle", async () => {
		const selected = join(agentDir, "legacy", "example.ts");
		factory(selected, "project-selected");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: [selected] }));
		const resources = loader();
		await resources.reload({ resolveProjectTrust: async ({ extensionsResult }) => {
			expect(extensionsResult.extensions).toEqual([]);
			expect(globalState[counter]).toBeUndefined();
			return true;
		} });
		expect(resources.getExtensions().extensions.map((e) => e.path)).toEqual([selected]);
		expect(globalState[counter]).toBe(1);
	});

	it.each(["missing", "broken"])("never falls back for %s project-selected exact legacy code", async (mode) => {
		const selected = join(agentDir, "legacy", "example.ts");
		if (mode === "broken") {
			mkdirSync(dirname(selected), { recursive: true });
			writeFileSync(selected, "throw new Error('broken project legacy'); export default function() {};");
		}
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: [selected] }));
		const resources = loader();
		await resources.reload({ resolveProjectTrust: async () => true });
		expect(resources.getExtensions().extensions).toEqual([]);
		expect(globalState[counter]).toBeUndefined();
		if (mode === "broken") {
			expect(resources.getExtensions().errors).toContainEqual(expect.objectContaining({ path: selected }));
		}
	});

	it("does not run deferred defaults when the trust callback throws", async () => {
		const resources = loader();
		await expect(resources.reload({ resolveProjectTrust: async () => { throw new Error("trust failed"); } }))
			.rejects.toThrow("trust failed");
		expect(globalState[counter]).toBeUndefined();
	});

	it("reuses ordinary user bootstrap factories and keeps noExtensions authoritative", async () => {
		const ordinary = join(agentDir, "extensions", "ordinary.ts");
		factory(ordinary, "ordinary");
		const resources = loader();
		await resources.reload({ resolveProjectTrust: async ({ extensionsResult }) => {
			expect(extensionsResult.extensions.map((e) => e.path)).toEqual([ordinary]);
			expect(globalState[counter]).toBe(1);
			return true;
		} });
		expect(resources.getExtensions().extensions.map((e) => e.path)).toEqual([ordinary, bundled]);
		expect(globalState[counter]).toBe(2);
		const disabled = loader({ noExtensions: true });
		await disabled.reload({ resolveProjectTrust: async ({ extensionsResult }) => {
			expect(extensionsResult.extensions).toEqual([]);
			return false;
		} });
		expect(disabled.getExtensions().extensions).toEqual([]);
		expect(globalState[counter]).toBe(2);
	});

	it("keeps explicit user selections as ordinary bootstrap inputs", async () => {
		settings([bundled]);
		const resources = loader();
		await resources.reload({ resolveProjectTrust: async ({ extensionsResult }) => {
			expect(extensionsResult.extensions.map((e) => e.path)).toEqual([bundled]);
			expect(globalState[counter]).toBe(1);
			return true;
		} });
		expect(resources.getExtensions().extensions.map((e) => e.path)).toEqual([bundled]);
		expect(globalState[counter]).toBe(1);
	});

	it.each(["user", "project"])("retains disabled exact legacy selections from a %s package filter", async (scope) => {
		const packageRoot = join(agentDir, "legacy-package");
		const selected = join(packageRoot, "extensions", "example.ts");
		factory(selected, "package-legacy");
		writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
			name: "legacy-package", pi: { extensions: ["extensions/example.ts"] },
		}));
		const settingsDir = scope === "user" ? agentDir : join(cwd, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		const packageSettings = { packages: [{ source: packageRoot, extensions: [] }] };
		writeFileSync(join(settingsDir, "settings.json"), JSON.stringify(packageSettings));
		const resources = loader({
			defaultExtensions: [{ path: bundled, legacyPaths: ["legacy-package/extensions/example.ts"] }],
		});
		await resources.reload({ resolveProjectTrust: async () => true });
		expect(resources.getExtensions().extensions).toEqual([]);
		expect(globalState[counter]).toBeUndefined();
		// Explicit physical selection remains native input, even with a disabled legacy package.
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
			...(scope === "user" ? packageSettings : {}), extensions: [bundled],
		}));
		await resources.reload({ resolveProjectTrust: async () => true });
		expect(resources.getExtensions().extensions.map((e) => e.path)).toEqual([bundled]);
		expect(globalState[counter]).toBe(1);
	});

	it.each(["user", "project", "cli"])("honors explicit npm ownership in %s scope regardless of installation state", async (scope) => {
		vi.stubEnv("PI_OFFLINE", "1");
		const installed = join(root, "other-native-prefix", "pi-web-access");
		// Keep native package resolution/filtering; isolate only the installation prefix, with no installer traffic.
		vi.spyOn(DefaultPackageManager.prototype as unknown as { getNpmInstallPath(): string }, "getNpmInstallPath")
			.mockReturnValue(installed);
		const source = "npm:pi-web-access@1.2.3";
		const settingsDir = scope === "project" ? join(cwd, ".pi") : agentDir;
		mkdirSync(settingsDir, { recursive: true });
		const makeLoader = () => loader({
			defaultExtensions: [{ path: bundled, legacyPaths: [], legacyPackageSources: ["npm:pi-web-access"] }],
			...(scope === "cli" ? { additionalExtensionPaths: [source] } : {}),
		});
		for (const state of ["missing", "disabled", "broken"]) {
			if (scope !== "cli") writeFileSync(join(settingsDir, "settings.json"), JSON.stringify({
				packages: [{ source, ...(state === "disabled" ? { extensions: [] } : {}) }],
			}));
			if (state !== "missing") {
				mkdirSync(installed, { recursive: true });
				writeFileSync(join(installed, "package.json"), JSON.stringify({
					name: "pi-web-access", version: "1.2.3", pi: { extensions: ["index.ts"] },
				}));
				if (state === "disabled" && scope !== "cli") factory(join(installed, "index.ts"), "package-legacy");
				else writeFileSync(join(installed, "index.ts"), "throw new Error('broken selected package'); export default function() {};");
			}
			const resources = makeLoader();
			await resources.reload({ resolveProjectTrust: async () => true });
			expect(resources.getExtensions().extensions).toEqual([]);
			expect(globalState[counter]).toBeUndefined();
		}
		// Selecting the physical bundle is still ordinary native input.
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [bundled],
			...(scope === "user" ? { packages: [source] } : {}),
		}));
		const explicit = makeLoader();
		await explicit.reload({ resolveProjectTrust: async () => true });
		expect(explicit.getExtensions().extensions.map((e) => e.path)).toEqual([bundled]);
		expect(globalState[counter]).toBe(1);
	});

	it.each([false, true])("ignores untrusted npm intent until trust resolves to %s", async (trust) => {
		vi.stubEnv("PI_OFFLINE", "1");
		vi.spyOn(DefaultPackageManager.prototype as unknown as { getNpmInstallPath(): string }, "getNpmInstallPath")
			.mockReturnValue(join(root, "missing"));
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:pi-mcp-adapter@9.0.0"] }));
		const resources = loader({ defaultExtensions: [{ path: bundled, legacyPaths: [], legacyPackageSources: ["npm:pi-mcp-adapter"] }] });
		await resources.reload({ resolveProjectTrust: async ({ extensionsResult }) => {
			expect(extensionsResult.extensions).toEqual([]);
			expect(globalState[counter]).toBeUndefined();
			return trust;
		} });
		expect(globalState[counter]).toBe(trust ? undefined : 1);
	});

	it("does not suppress defaults for a different npm identity", async () => {
		vi.stubEnv("PI_OFFLINE", "1");
		vi.spyOn(DefaultPackageManager.prototype as unknown as { getNpmInstallPath(): string }, "getNpmInstallPath")
			.mockReturnValue(join(root, "missing"));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-web-access-other@1.2.3"] }));
		const resources = loader({ defaultExtensions: [{ path: bundled, legacyPaths: [], legacyPackageSources: ["npm:pi-web-access"] }] });
		await resources.reload({ resolveProjectTrust: async () => false });
		expect(resources.getExtensions().extensions.map((e) => e.path)).toEqual([bundled]);
		expect(globalState[counter]).toBe(1);
	});

	it("does not confuse package identity with module basename or registered command name", async () => {
		const unrelated = join(agentDir, "extensions", "pi-web-access.ts");
		factory(unrelated, "pi-web-access");
		const resources = loader({ defaultExtensions: [{ path: bundled, legacyPaths: [], legacyPackageSources: ["npm:pi-web-access"] }] });
		await resources.reload({ resolveProjectTrust: async () => false });
		expect(resources.getExtensions().extensions.map((e) => e.path)).toEqual([unrelated, bundled]);
		expect(globalState[counter]).toBe(2);
	});

	it("recognizes native directory entry points without basename deduplication", async () => {
		const directory = join(agentDir, "extensions", "example");
		const entry = join(directory, "index.ts");
		factory(entry, "directory-legacy");
		const resources = loader({ defaultExtensions: [{ path: bundled, legacyPaths: ["extensions/example"] }] });
		await resources.reload();
		expect(resources.getExtensions().extensions.map((e) => e.path)).toEqual([entry]);
		expect(globalState[counter]).toBe(1);
	});

	it("does not replace an explicit absent or broken legacy selection with the bundle", async () => {
		settings(["legacy/example.ts"]);
		const resources = loader();
		await resources.reload();
		expect(resources.getExtensions().extensions).toEqual([]);
		expect(globalState[counter]).toBeUndefined();
		const broken = join(agentDir, "legacy", "example.ts");
		mkdirSync(dirname(broken), { recursive: true });
		writeFileSync(broken, "throw new Error('broken legacy'); export default function() {};");
		await resources.reload();
		expect(resources.getExtensions().extensions).toEqual([]);
		expect(resources.getExtensions().errors).toContainEqual(expect.objectContaining({ path: broken }));
		expect(globalState[counter]).toBeUndefined();
	});

	it.each([
		["!extensions/*.ts"],
		["-extensions/example.ts"],
		["!extensions/*.ts", "+extensions/example.ts", "-extensions/example.ts"],
	])("disables absent legacy counterparts through native overrides %j", async (...patterns) => {
		settings(patterns);
		const resources = loader();
		await resources.reload();
		expect(resources.getExtensions().extensions).toEqual([]);
		expect(globalState[counter]).toBeUndefined();
	});

	it("never evaluates disabled legacy code or falls back after an auto legacy load failure", async () => {
		factory(legacy, "legacy");
		settings(["-extensions/example.ts"]);
		const resources = loader();
		await resources.reload();
		expect(resources.getExtensions().extensions).toEqual([]);
		expect(globalState[counter]).toBeUndefined();
		settings([]);
		writeFileSync(legacy, "throw new Error('broken auto legacy'); export default function() {};");
		await resources.reload();
		expect(resources.getExtensions().extensions).toEqual([]);
		expect(resources.getExtensions().errors).toContainEqual(expect.objectContaining({ path: legacy }));
		expect(globalState[counter]).toBeUndefined();
	});

	it("applies native force-include and physical bundled-path overrides", async () => {
		settings(["!extensions/*.ts", "+extensions/example.ts"]);
		const resources = loader();
		await resources.reload();
		expect(resources.getExtensions().extensions.map((e) => e.path)).toEqual([bundled]);
		settings(["!extensions/*.ts", "+extensions/example.ts", `-${bundled}`]);
		await resources.reload();
		expect(resources.getExtensions().extensions).toEqual([]);
	});

	it("keeps unrelated same-basename code, honors noExtensions, and never loads untrusted project code", async () => {
		const custom = join(agentDir, "custom", "example.ts");
		factory(custom, "custom");
		settings(["custom/example.ts"]);
		factory(join(cwd, ".pi", "extensions", "project.ts"), "project");
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const resources = loader({ settingsManager });
		await resources.reload();
		expect(resources.getExtensions().extensions.map((e) => e.path)).toEqual([custom, bundled]);
		const disabled = loader({ noExtensions: true });
		await disabled.reload();
		expect(disabled.getExtensions().extensions).toEqual([]);
	});

	it("reselects auto legacy and default on reload without stale cache selection", async () => {
		const resources = loader();
		await resources.reload();
		factory(legacy, "legacy");
		await resources.reload();
		expect(resources.getExtensions().extensions.map((e) => e.path)).toEqual([legacy]);
		rmSync(legacy);
		await resources.reload();
		expect(resources.getExtensions().extensions.map((e) => e.path)).toEqual([bundled]);
		expect(globalState[counter]).toBe(3);
	});
});
