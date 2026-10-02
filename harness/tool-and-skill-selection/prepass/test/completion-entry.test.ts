import test from "node:test";
import assert from "node:assert/strict";
import { isBuiltin } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createOwnerRequire, resolveOwnerModule, resolveSdkModule } from "../../../../scripts/lib/package-resolution.mjs";
import { sourceDescriptor, sourceFixture } from "../../../../harness/agent-processes/lib/sdk-integration/test/source-fixture.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../../../");
const workerPath = path.join(testDir, "completion-entry-worker.ts");
const verifierPath = path.join(repoRoot, "harness", "agent-processes", "lib", "sdk-integration", "sdk-runtime-artifact.ts");
const compatSpecifier = "@earendil-works/pi-ai/compat";
const piPackageRoots: Readonly<Record<string, string>> = {
	"@earendil-works/pi-ai": sourceFixture.packageRoots.ai,
	"@earendil-works/pi-agent-core": sourceFixture.packageRoots.agent,
	"@earendil-works/pi-tui": sourceFixture.packageRoots.tui,
	"@earendil-works/pi-coding-agent": sourceFixture.packageRoots.codingAgent,
	"@mariozechner/pi-ai": sourceFixture.packageRoots.ai,
	"@mariozechner/pi-agent-core": sourceFixture.packageRoots.agent,
	"@mariozechner/pi-tui": sourceFixture.packageRoots.tui,
	"@mariozechner/pi-coding-agent": sourceFixture.packageRoots.codingAgent,
};

function piPackageName(specifier: string): string | undefined {
	return Object.keys(piPackageRoots).find((name) => specifier === name || specifier.startsWith(`${name}/`));
}

function selectedPiExportPath(specifier: string): string {
	const packageName = piPackageName(specifier);
	assert.ok(packageName, `unexpected public Pi specifier: ${specifier}`);
	const resolved = realpathSync(resolveSdkModule(specifier, { sdkPath: sourceDescriptor.sdkPath }));
	const packageRoot = realpathSync(piPackageRoots[packageName]);
	const relative = path.relative(packageRoot, resolved);
	assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
		`${specifier} must resolve inside the selected artifact package: ${resolved}`);
	assert.match(resolved, /\.m?js$/u, `${specifier} must resolve to a JavaScript export: ${resolved}`);
	return resolved;
}

function completionEntryBundlePlugin() {
	return {
		name: "completion-entry-selected-sdk-externals",
		setup(build: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string }) => unknown) => void }) {
			build.onResolve({ filter: /^@(?:earendil-works|mariozechner)\// }, (args) => {
				const resolved = selectedPiExportPath(args.path);
				return { path: pathToFileURL(resolved).href, external: true };
			});
			build.onResolve({ filter: /.*/ }, (args) => {
				if (args.path.startsWith(".") || path.isAbsolute(args.path) || isBuiltin(args.path)) return undefined;
				return { path: resolveOwnerModule(args.path) };
			});
		},
	};
}

function writeNetworkDenialPreload(preloadPath: string, denialLogPath: string): void {
	writeFileSync(preloadPath, [
		"const fs = require('node:fs');",
		`const log = ${JSON.stringify(denialLogPath)};`,
		"const deny = (api) => (...args) => { fs.appendFileSync(log, JSON.stringify({ api }) + '\\n'); throw new Error('Network denied by completion-entry fixture: ' + api); };",
		"const net = require('node:net');",
		"const originalConnect = net.Socket.prototype.connect;",
		"net.Socket.prototype.connect = function (...args) {",
		"  const normalized = Array.isArray(args[0]) ? args[0] : args;",
		"  const first = normalized[0];",
		"  const socketPath = typeof first === 'string' ? first : first && first.path;",
		"  if (typeof socketPath === 'string' && (socketPath.startsWith('\\\\\\\\.\\\\pipe\\\\') || socketPath.startsWith('\\\\\\\\?\\\\pipe\\\\') || socketPath.startsWith('/'))) return originalConnect.apply(this, args);",
		"  return deny('net.Socket.connect')(...args);",
		"};",
		"for (const name of ['node:http', 'node:https']) { const api = require(name); api.request = deny(name + '.request'); api.get = deny(name + '.get'); }",
		"require('node:tls').connect = deny('tls.connect');",
		"require('node:dgram').createSocket = deny('dgram.createSocket');",
		"const dns = require('node:dns');",
		"for (const name of Object.keys(dns)) if (/^(lookup|resolve|reverse)/.test(name) && typeof dns[name] === 'function') dns[name] = deny('dns.' + name);",
		"for (const name of Object.keys(dns.promises)) if (typeof dns.promises[name] === 'function') dns.promises[name] = deny('dns.promises.' + name);",
		"globalThis.fetch = deny('fetch');",
		"require('node:module').syncBuiltinESMExports();",
	].join("\n"), "utf-8");
}

function isolatedWorkerEnv(fixtureRoot: string, denialLogPath: string): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_TEST_CONTEXT", "NODE_V8_COVERAGE"]) delete env[key];
	const directories: Record<string, string> = {
		TMP: path.join(fixtureRoot, "tmp"),
		TEMP: path.join(fixtureRoot, "tmp"),
		TMPDIR: path.join(fixtureRoot, "tmp"),
		HOME: path.join(fixtureRoot, "home"),
		USERPROFILE: path.join(fixtureRoot, "home"),
		APPDATA: path.join(fixtureRoot, "appdata"),
		LOCALAPPDATA: path.join(fixtureRoot, "localappdata"),
		XDG_CONFIG_HOME: path.join(fixtureRoot, "xdg-config"),
		XDG_CACHE_HOME: path.join(fixtureRoot, "xdg-cache"),
		XDG_DATA_HOME: path.join(fixtureRoot, "xdg-data"),
		PIE_DATA_DIR: path.join(fixtureRoot, "pie-data"),
		PI_CODING_AGENT_DIR: path.join(fixtureRoot, "agent"),
		PI_CODING_AGENT_AUTH_DIR: path.join(fixtureRoot, "auth"),
		PI_CODING_AGENT_SESSION_DIR: path.join(fixtureRoot, "sessions"),
		PSModuleAnalysisCachePath: path.join(fixtureRoot, "psmodule", "moduleanalysis"),
	};
	for (const directory of Object.values(directories)) mkdirSync(directory, { recursive: true });
	Object.assign(env, directories, {
		PREPASS_COMPLETION_ENTRY_SOURCE_DESCRIPTOR: JSON.stringify(sourceDescriptor),
		PREPASS_COMPLETION_ENTRY_ARTIFACT_DIR: sourceDescriptor.artifactDir,
		PREPASS_COMPLETION_ENTRY_SDK_PATH: sourceDescriptor.sdkPath,
		PREPASS_COMPLETION_ENTRY_COMPAT_PATH: selectedPiExportPath(compatSpecifier),
		PREPASS_COMPLETION_ENTRY_PI_AI_ROOT: sourceFixture.packageRoots.ai,
		PREPASS_COMPLETION_ENTRY_DENY_LOG_PATH: denialLogPath,
		PIE_TEST_FORCE_OFFLINE: "1",
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		npm_config_offline: "true",
		HTTP_PROXY: "",
		HTTPS_PROXY: "",
		ALL_PROXY: "",
		NO_PROXY: "*",
	});
	return env;
}

test("prepass lazily resolves and invokes the selected artifact's public pi-ai compat export without network", async () => {
	const tsconfigPath = process.env.TSX_TSCONFIG_PATH;
	assert.ok(tsconfigPath && path.isAbsolute(tsconfigPath) && existsSync(tsconfigPath),
		"the shared verification runner must provide its selected-SDK tsx alias config");
	assert.equal(sourceDescriptor.artifactDir, sourceFixture.piRoot,
		"the source fixture descriptor must bind the selected runner artifact");
	assert.equal(sourceDescriptor.sdkPath, sourceFixture.packageRoots.codingAgent,
		"the descriptor SDK must be the coding-agent package in the verified source graph");

	const compatPath = selectedPiExportPath(compatSpecifier);
	const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf-8")) as {
		compilerOptions?: { paths?: Record<string, string[]> };
	};
	const compatAlias = tsconfig.compilerOptions?.paths?.[compatSpecifier]?.[0];
	assert.ok(compatAlias && path.isAbsolute(compatAlias),
		`the shared alias config must explicitly map ${compatSpecifier} to the selected artifact`);
	assert.equal(realpathSync(compatAlias), compatPath,
		"the public compat alias must target the export in the verified artifact, not an installed fallback");

	const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pie-prepass-completion-entry-"));
	const denialLogPath = path.join(fixtureRoot, "denials.jsonl");
	const denyPreloadPath = path.join(fixtureRoot, "deny-network.cjs");
	const bundlePath = path.join(fixtureRoot, "completion-entry-fixture.mjs");
	const verifierBundlePath = path.join(fixtureRoot, "sdk-artifact-verifier.mjs");
	const bootstrapPath = path.join(fixtureRoot, "bootstrap.mjs");
	const workspace = path.join(fixtureRoot, "workspace");
	mkdirSync(workspace, { recursive: true });
	writeNetworkDenialPreload(denyPreloadPath, denialLogPath);

	const ownerRequire = createOwnerRequire();
	const esbuildPath = resolveOwnerModule("esbuild");
	const esbuild = ownerRequire(esbuildPath) as { build: (options: Record<string, unknown>) => Promise<unknown> };
	const commonBuildOptions = { bundle: true, format: "esm", platform: "node", logLevel: "silent" };
	await esbuild.build({
		...commonBuildOptions,
		entryPoints: [workerPath],
		outfile: bundlePath,
		plugins: [completionEntryBundlePlugin()],
	});
	await esbuild.build({
		...commonBuildOptions,
		entryPoints: [verifierPath],
		outfile: verifierBundlePath,
	});
	assert.ok(readFileSync(bundlePath, "utf-8").includes(pathToFileURL(compatPath).href),
		"the ESM fixture must externalize compat to the selected artifact's absolute public export");

	writeFileSync(bootstrapPath, [
		`import { verifySdkRuntimeArtifactDescriptor } from ${JSON.stringify(pathToFileURL(verifierBundlePath).href)};`,
		"const descriptor = JSON.parse(process.env.PREPASS_COMPLETION_ENTRY_SOURCE_DESCRIPTOR ?? 'null');",
		"await verifySdkRuntimeArtifactDescriptor(descriptor, { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules });",
		`await import(${JSON.stringify(pathToFileURL(bundlePath).href)});`,
	].join("\n"), "utf-8");

	const run = spawnSync(process.execPath, [
		"--require", denyPreloadPath,
		"--test", "--test-force-exit", bootstrapPath,
	], {
		cwd: workspace,
		encoding: "utf-8",
		timeout: 120_000,
		env: isolatedWorkerEnv(fixtureRoot, denialLogPath),
	});
	const stdoutLog = path.join(fixtureRoot, "worker.stdout.log");
	const stderrLog = path.join(fixtureRoot, "worker.stderr.log");
	writeFileSync(stdoutLog, run.stdout ?? "", "utf-8");
	writeFileSync(stderrLog, run.stderr ?? "", "utf-8");

	assert.equal(run.status, 0,
		`completion-entry worker failed (${run.status}); retained logs: ${stdoutLog}, ${stderrLog}\n${run.stdout}\n${run.stderr}`);
	assert.match(`${run.stdout ?? ""}\n${run.stderr ?? ""}`, /PREPASS_COMPLETION_ENTRY_OK/u);
	assert.ok(!existsSync(denialLogPath),
		`the network-denial preload recorded an attempted dial; retained log: ${denialLogPath}`);
	rmSync(fixtureRoot, { recursive: true, force: true });
});
