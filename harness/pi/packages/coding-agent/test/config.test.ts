import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	detectInstallMethod,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	getUpdateInstruction,
} from "../src/config.ts";

const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
const originalPath = process.env.PATH;
const originalPiPackageDir = process.env.PI_PACKAGE_DIR;
const originalArgv1 = process.argv[1];
let tempDir: string | undefined;

function setExecPath(value: string): void {
	Object.defineProperty(process, "execPath", {
		value,
		configurable: true,
	});
}

// Never discover an installed manager through the developer's PATH. cross-spawn
// needs the native cmd.exe directory on Windows to execute fixture-owned .cmd files.
function privatePath(binDir?: string): string {
	if (process.platform !== "win32") return binDir ?? join(tmpdir(), "pi-no-manager-bin");
	const comSpec = process.env.ComSpec;
	if (!comSpec) throw new Error("Windows manager fixtures require native ComSpec");
	return [binDir, dirname(comSpec)].filter(Boolean).join(delimiter);
}

beforeEach(() => {
	process.env.PATH = privatePath();
});

afterEach(() => {
	if (execPathDescriptor) {
		Object.defineProperty(process, "execPath", execPathDescriptor);
	}
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
	if (originalPiPackageDir === undefined) {
		delete process.env.PI_PACKAGE_DIR;
	} else {
		process.env.PI_PACKAGE_DIR = originalPiPackageDir;
	}
	if (originalArgv1 === undefined) {
		process.argv.splice(1, 1);
	} else {
		process.argv[1] = originalArgv1;
	}
	if (tempDir) {
		chmodSync(tempDir, 0o700);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function createNpmPrefixInstall(template = "pi-prefix-"): { prefix: string; packageDir: string } {
	const prefix = mkdtempSync(join(tmpdir(), template));
	const root = join(prefix, "lib", "node_modules");
	const scopeDir = join(root, "@earendil-works");
	const packageDir = join(scopeDir, "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	const binDir = join(prefix, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeManager(binDir, "npm", [
		{ args: ["root", "-g"], output: root },
		{ args: ["--prefix", prefix, "root", "-g"], output: root },
	]);
	process.env.PATH = privatePath(binDir);
	tempDir = prefix;
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { prefix, packageDir };
}

function createPnpmGlobalInstall(): { root: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "pi-pnpm-"));
	const binDir = join(temp, "bin");
	const root = join(temp, "pnpm", "global", "5", "node_modules");
	const packageDir = join(root, "@mariozechner", "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFakeManager(binDir, "pnpm", [{ args: ["root", "-g"], output: root }]);
	tempDir = temp;
	process.env.PATH = privatePath(binDir);
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(
		join(
			root,
			".pnpm",
			"@mariozechner+pi-coding-agent@0.0.0",
			"node_modules",
			"@mariozechner",
			"pi-coding-agent",
			"dist",
			"cli.js",
		),
	);
	return { root, packageDir };
}

function createYarnGlobalInstall(): { globalDir: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "pi-yarn-"));
	const binDir = join(temp, "bin");
	const globalDir = join(temp, "yarn", "global");
	const packageDir = join(globalDir, "node_modules", "@mariozechner", "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFakeManager(binDir, "yarn", [{ args: ["global", "dir"], output: globalDir }]);
	tempDir = temp;
	process.env.PATH = privatePath(binDir);
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(join(globalDir, ".yarn", "@mariozechner", "pi-coding-agent", "dist", "cli.js"));
	return { globalDir, packageDir };
}

function createBunGlobalInstall(): { packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "pi-bun-"));
	const prefix = join(temp, ".bun");
	const bunBin = join(prefix, "bin");
	const root = join(prefix, "install", "global", "node_modules");
	const scopeDir = join(root, "@earendil-works");
	const packageDir = join(scopeDir, "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(bunBin, { recursive: true });
	writeFakeManager(bunBin, "bun", [{ args: ["pm", "bin", "-g"], output: bunBin }]);
	tempDir = temp;
	process.env.PATH = privatePath(bunBin);
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { packageDir };
}

function writeFakeManager(binDir: string, manager: string, responses: { args: string[]; output: string }[]): void {
	const executable = join(binDir, process.platform === "win32" ? `${manager}.cmd` : manager);
	const quoteSh = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	const script =
		process.platform === "win32"
			? `@echo off\r\n${responses
					.map(({ args, output }, index) => {
						const checks = [...args, ""].map((arg, i) => `if not "%~${i + 1}"=="${arg}" goto next${index}`);
						const escapedOutput = output.replace(/[\^&|<>()]/g, "^$&");
						return `${checks.join("\r\n")}\r\necho(${escapedOutput}\r\nexit /b 0\r\n:next${index}\r\n`;
					})
					.join("")}exit /b 1\r\n`
			: `#!/bin/sh\n${responses
					.map(({ args, output }) => {
						const checks = [
							`[ "$#" = "${args.length}" ]`,
							...args.map((arg, i) => `[ "$${i + 1}" = ${quoteSh(arg)} ]`),
						];
						return `if ${checks.join(" && ")}; then\n\tprintf '%s\\n' ${quoteSh(output)}\n\texit 0\nfi\n`;
					})
					.join("")}exit 1\n`;
	writeFileSync(executable, script);
	chmodSync(executable, 0o755);
}

describe("detectInstallMethod", () => {
	test("detects pnpm from Windows .pnpm install paths", () => {
		setExecPath(
			"C:\\Users\\Admin\\Documents\\pnpm-repository\\global\\5\\.pnpm\\@earendil-works+pi-coding-agent@0.67.68\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",
		);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(getUpdateInstruction("@earendil-works/pi-coding-agent")).toBe(
			"Run: pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @earendil-works/pi-coding-agent",
		);
	});

	test("does not self-update unknown wrapper installs", () => {
		setExecPath("/usr/local/bin/node");

		expect(detectInstallMethod()).toBe("unknown");
		expect(getSelfUpdateCommand("@earendil-works/pi-coding-agent")).toBeUndefined();
		expect(getUpdateInstruction("@earendil-works/pi-coding-agent")).toBe(
			"Update @earendil-works/pi-coding-agent using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});

	test("self-updates npm installs from custom prefixes", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent");

		expect(detectInstallMethod()).toBe("npm");
		expect(command).toEqual({
			command: "npm",
			args: [
				"--prefix",
				prefix,
				"install",
				"-g",
				"--ignore-scripts",
				"--min-release-age=0",
				"@earendil-works/pi-coding-agent",
			],
			display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @earendil-works/pi-coding-agent`,
		});
	});

	test("self-updates exact npm versions without uninstalling the current package", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent", undefined, {
			packageName: "@earendil-works/pi-coding-agent",
			installSpec: "@earendil-works/pi-coding-agent@1.2.3",
		});

		expect(command).toEqual({
			command: "npm",
			args: [
				"--prefix",
				prefix,
				"install",
				"-g",
				"--ignore-scripts",
				"--min-release-age=0",
				"@earendil-works/pi-coding-agent@1.2.3",
			],
			display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @earendil-works/pi-coding-agent@1.2.3`,
		});
	});

	test("self-updates renamed packages from the current install prefix", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "--ignore-scripts", "--min-release-age=0", "@new-scope/pi"],
			display: `npm --prefix ${prefix} uninstall -g @mariozechner/pi-coding-agent && npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @new-scope/pi`,
			steps: [
				{
					command: "npm",
					args: ["--prefix", prefix, "uninstall", "-g", "@mariozechner/pi-coding-agent"],
					display: `npm --prefix ${prefix} uninstall -g @mariozechner/pi-coding-agent`,
				},
				{
					command: "npm",
					args: ["--prefix", prefix, "install", "-g", "--ignore-scripts", "--min-release-age=0", "@new-scope/pi"],
					display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @new-scope/pi`,
				},
			],
		});
	});

	test("self-update respects configured npmCommand", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent", ["npm", "--prefix", prefix]);

		expect(command).toEqual({
			command: "npm",
			args: [
				"--prefix",
				prefix,
				"install",
				"-g",
				"--ignore-scripts",
				"--min-release-age=0",
				"@earendil-works/pi-coding-agent",
			],
			display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @earendil-works/pi-coding-agent`,
		});
	});

	test("self-update treats empty npmCommand as unset", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent", []);

		expect(command?.args).toEqual([
			"--prefix",
			prefix,
			"install",
			"-g",
			"--ignore-scripts",
			"--min-release-age=0",
			"@earendil-works/pi-coding-agent",
		]);
	});

	test("quotes npm self-update display paths", () => {
		const { prefix } = createNpmPrefixInstall("pi prefix ");

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent");

		expect(command?.display).toBe(
			`npm --prefix "${prefix}" install -g --ignore-scripts --min-release-age=0 @earendil-works/pi-coding-agent`,
		);
	});

	test("does not infer Windows npm custom prefixes from package paths", () => {
		const packageDir = "C:\\Users\\Admin\\npm prefix\\node_modules\\@earendil-works\\pi-coding-agent";
		process.env.PI_PACKAGE_DIR = packageDir;
		setExecPath(`${packageDir}\\dist\\cli.js`);

		expect(detectInstallMethod()).toBe("npm");
		expect(getUpdateInstruction("@earendil-works/pi-coding-agent")).toBe(
			"Run: npm install -g --ignore-scripts --min-release-age=0 @earendil-works/pi-coding-agent",
		);
	});

	test("self-updates bun global installs from bun pm bin", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "--ignore-scripts", "--minimum-release-age=0", "@earendil-works/pi-coding-agent"],
			display: "bun install -g --ignore-scripts --minimum-release-age=0 @earendil-works/pi-coding-agent",
		});
	});

	test("self-updates renamed pnpm global installs by removing the old package first", () => {
		createPnpmGlobalInstall();

		const command = getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(detectInstallMethod()).toBe("pnpm");
		expect(command).toEqual({
			command: "pnpm",
			args: ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", "@new-scope/pi"],
			display:
				"pnpm remove -g @mariozechner/pi-coding-agent && pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @new-scope/pi",
			steps: [
				{
					command: "pnpm",
					args: ["remove", "-g", "@mariozechner/pi-coding-agent"],
					display: "pnpm remove -g @mariozechner/pi-coding-agent",
				},
				{
					command: "pnpm",
					args: ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", "@new-scope/pi"],
					display: "pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @new-scope/pi",
				},
			],
		});
	});

	test("self-updates pnpm v11 global installs resolved through the store", () => {
		const temp = mkdtempSync(join(tmpdir(), "pi-pnpm11-"));
		const binDir = join(temp, "bin");
		const root = join(temp, "Library", "pnpm", "global", "v11");
		const packageName = "@earendil-works/pi-coding-agent";
		const globalPackageDir = join(root, "11e9a", "node_modules", "@earendil-works", "pi-coding-agent");
		const storePackageDir = join(
			temp,
			"Library",
			"pnpm",
			"store",
			"v11",
			"links",
			"@earendil-works",
			"pi-coding-agent",
			"0.75.0",
			"hash",
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
		);
		mkdirSync(globalPackageDir, { recursive: true });
		mkdirSync(storePackageDir, { recursive: true });
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(globalPackageDir, "package.json"), "{}");
		writeFakeManager(binDir, "pnpm", [{ args: ["root", "-g"], output: root }]);
		tempDir = temp;
		process.env.PATH = privatePath(binDir);
		process.env.PI_PACKAGE_DIR = storePackageDir;
		process.argv[1] = join(globalPackageDir, "dist", "cli.js");
		setExecPath(join(storePackageDir, "dist", "cli.js"));

		const command = getSelfUpdateCommand(packageName);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(command).toEqual({
			command: "pnpm",
			args: ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", packageName],
			display: `pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 ${packageName}`,
		});
	});

	test("self-updates renamed yarn global installs by removing the old package first", () => {
		createYarnGlobalInstall();

		const command = getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(detectInstallMethod()).toBe("yarn");
		expect(command).toEqual({
			command: "yarn",
			args: ["global", "add", "--ignore-scripts", "@new-scope/pi"],
			display: "yarn global remove @mariozechner/pi-coding-agent && yarn global add --ignore-scripts @new-scope/pi",
			steps: [
				{
					command: "yarn",
					args: ["global", "remove", "@mariozechner/pi-coding-agent"],
					display: "yarn global remove @mariozechner/pi-coding-agent",
				},
				{
					command: "yarn",
					args: ["global", "add", "--ignore-scripts", "@new-scope/pi"],
					display: "yarn global add --ignore-scripts @new-scope/pi",
				},
			],
		});
	});

	test("self-updates renamed bun global installs by removing the old package first", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "--ignore-scripts", "--minimum-release-age=0", "@new-scope/pi"],
			display:
				"bun uninstall -g @mariozechner/pi-coding-agent && bun install -g --ignore-scripts --minimum-release-age=0 @new-scope/pi",
			steps: [
				{
					command: "bun",
					args: ["uninstall", "-g", "@mariozechner/pi-coding-agent"],
					display: "bun uninstall -g @mariozechner/pi-coding-agent",
				},
				{
					command: "bun",
					args: ["install", "-g", "--ignore-scripts", "--minimum-release-age=0", "@new-scope/pi"],
					display: "bun install -g --ignore-scripts --minimum-release-age=0 @new-scope/pi",
				},
			],
		});
	});

	test("does not self-update when npm install path is not writable", (context) => {
		const { packageDir } = createNpmPrefixInstall();
		try {
			chmodSync(packageDir, 0o500);
			let writable = true;
			try {
				accessSync(packageDir, constants.W_OK);
			} catch (error) {
				if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				writable = false;
			}
			if (writable) {
				context.skip("Permission capability unavailable: chmod(0500) still allows access(W_OK)");
				return;
			}

			expect(getSelfUpdateCommand("@earendil-works/pi-coding-agent")).toBeUndefined();
			expect(getSelfUpdateUnavailableInstruction("@earendil-works/pi-coding-agent")).toContain(
				"the install path is not writable",
			);
		} finally {
			chmodSync(packageDir, 0o700);
		}
	});
});
