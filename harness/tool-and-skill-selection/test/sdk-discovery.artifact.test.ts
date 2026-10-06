/**
 * Verified-source SDK discovery regression for the skill-pruner root shim.
 *
 * The SDK load runs in a spawned worker (sdk-discovery-worker.ts): the real
 * SDK's loader evaluates the repo's TS modules through its own ESM import
 * chain, and mixing those instances with the CJS `require()` instances held by
 * the other tests of this package corrupts node's coverage merge (it DROPPED
 * real coverage, e.g. prepass.ts 88.9% -> 58.2%). A separate process keeps one
 * module-instance set per process, so this regression still runs in every
 * suite without poisoning the package's honest coverage aggregate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sourceDescriptor, sourceFixture, sourceLoadMode } from "../../agent-processes/lib/sdk-integration/test/source-fixture.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const worker = path.join(repoRoot, "harness", "tool-and-skill-selection", "test", "sdk-discovery-worker.ts");
const SOURCE_MODE_ENV = "PIE_SKILL_PRUNER_SDK_DISCOVERY_SOURCE_MODE";
const DENIAL_LOG_ENV = "PIE_SKILL_PRUNER_SDK_DISCOVERY_DENIAL_LOG";

function writeNetworkDenialPreload(preloadPath: string, denialLogPath: string): void {
	writeFileSync(preloadPath, [
		"const fs = require('node:fs');",
		`const log = ${JSON.stringify(denialLogPath)};`,
		"const deny = (api) => (...args) => { fs.appendFileSync(log, JSON.stringify({ api }) + '\\n'); throw new Error('Network denied by SDK discovery fixture: ' + api); };",
		"const localHost = (value) => { const host = String(value ?? '').replace(/^\\[|\\]$/g, '').toLowerCase(); return host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' || /^127(?:\\.\\d{1,3}){3}$/.test(host); };",
		"const localIpc = (value) => typeof value === 'string' && (value.startsWith('\\\\\\\\.\\\\pipe\\\\') || value.startsWith('\\\\\\\\?\\\\pipe\\\\') || value.startsWith('/'));",
		"const localUrl = (input, options) => { try { const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input && typeof input === 'object' && input.protocol ? input.protocol + '//' + (input.host || input.hostname || '') : 'http://' + ((options && (options.host || options.hostname)) || (input && (input.host || input.hostname)) || '')); return localHost(url.hostname); } catch { return false; } };",
		"const net = require('node:net');",
		"const originalConnect = net.Socket.prototype.connect;",
		"net.Socket.prototype.connect = function (...args) {",
		"  const first = args[0]; const second = args[1];",
		"  const socketPath = typeof first === 'string' ? first : first && typeof first === 'object' ? first.path : undefined;",
		"  if (localIpc(socketPath)) return originalConnect.apply(this, args);",
		"  const host = first && typeof first === 'object' ? first.host || first.hostname : typeof first === 'number' ? typeof second === 'string' ? second : second && (second.host || second.hostname) : typeof first === 'string' ? first : undefined;",
		"  if (localHost(host)) return originalConnect.apply(this, args);",
		"  return deny('net.Socket.connect')(...args);",
		"};",
		"for (const name of ['node:http', 'node:https']) { const api = require(name); for (const method of ['request', 'get']) { const original = api[method]; api[method] = function (input, options, ...rest) { if (localUrl(input, options)) return original.call(this, input, options, ...rest); return deny(name + '.' + method)(input, options, ...rest); }; } }",
		"const tls = require('node:tls'); const originalTlsConnect = tls.connect; tls.connect = function (...args) { const options = args[0]; const host = options && typeof options === 'object' ? options.host || options.hostname : args[1]; if (localHost(host)) return originalTlsConnect.apply(this, args); return deny('tls.connect')(...args); };",
		"const dgram = require('node:dgram'); dgram.createSocket = deny('dgram.createSocket');",
		"const dns = require('node:dns'); for (const name of Object.keys(dns)) if (/^(lookup|resolve|reverse)/.test(name) && typeof dns[name] === 'function') dns[name] = deny('dns.' + name); for (const name of Object.keys(dns.promises)) if (typeof dns.promises[name] === 'function') dns.promises[name] = deny('dns.promises.' + name);",
		"const originalFetch = globalThis.fetch; globalThis.fetch = (input, ...args) => localUrl(input) ? originalFetch(input, ...args) : deny('fetch')(input, ...args);",
		"require('node:module').syncBuiltinESMExports();",
	].join("\n"), "utf-8");
}

function isolatedWorkerEnv(fixtureRoot: string, denialLogPath: string): NodeJS.ProcessEnv {
	const allowed = new Set([
		"path", "systemroot", "windir", "comspec", "pathext", "lang", "lc_all", "tz",
	]);
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())),
	);
	const home = path.join(fixtureRoot, "home");
	const temp = path.join(fixtureRoot, "tmp");
	const directories: Record<string, string> = {
		TMP: temp,
		TEMP: temp,
		TMPDIR: temp,
		HOME: home,
		USERPROFILE: home,
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
	const tsconfigPath = process.env.TSX_TSCONFIG_PATH;
	assert.ok(tsconfigPath && path.isAbsolute(tsconfigPath) && existsSync(tsconfigPath),
		"the shared verification runner must provide its selected-SDK tsx alias config");
	return {
		...inherited,
		...directories,
		TSX_TSCONFIG_PATH: tsconfigPath,
		[SOURCE_MODE_ENV]: JSON.stringify(sourceLoadMode),
		[DENIAL_LOG_ENV]: denialLogPath,
		PIE_TEST_FORCE_OFFLINE: "1",
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		npm_config_offline: "true",
		HTTP_PROXY: "",
		HTTPS_PROXY: "",
		ALL_PROXY: "",
		NO_PROXY: "*",
	};
}

test("verified source SDK discovery loads the root shim with one shared selector and recovery state", () => {
	assert.equal(sourceDescriptor.artifactDir, sourceFixture.piRoot,
		"the source fixture descriptor must bind the selected runner artifact");
	assert.equal(sourceDescriptor.sdkPath, sourceFixture.packageRoots.codingAgent,
		"the descriptor SDK must be the coding-agent package in the verified source graph");
	assert.equal(sourceLoadMode.mode, "source-artifact");
	assert.equal(sourceLoadMode.descriptor, sourceDescriptor);

	const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "pie-skill-pruner-sdk-discovery-"));
	const denialLogPath = path.join(fixtureRoot, "network-denials.jsonl");
	const preloadPath = path.join(fixtureRoot, "deny-network.cjs");
	writeNetworkDenialPreload(preloadPath, denialLogPath);
	try {
		const result = spawnSync(process.execPath, ["--require", preloadPath, tsxCli, worker], {
			cwd: repoRoot,
			encoding: "utf-8",
			timeout: 120_000,
			// Keep the worker out of the test runner's coverage merge; it evaluates
			// the selected SDK and the same TS sources through its own ESM graph.
			env: isolatedWorkerEnv(fixtureRoot, denialLogPath),
		});
		assert.equal(result.status, 0, `SDK discovery worker failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout ?? "", /SDK_DISCOVERY_OK/u);
		const denialDetails = existsSync(denialLogPath) ? readFileSync(denialLogPath, "utf-8") : "";
		assert.ok(!existsSync(denialLogPath),
			`the network-denial preload recorded an attempted external dial: ${denialDetails}`);
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
});
