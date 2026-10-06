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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sourceDescriptor, sourceFixture, sourceLoadMode } from "../../agent-processes/lib/sdk-integration/test/source-fixture.js";
import { buildSanitizedRealChildTestEnv, trustedTestChildCoverageEnv } from "../../agent-processes/test/fixtures/sanitized-real-child-env.js";

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

function isolatedWorkerEnv(fixtureRoot: string, denialLogPath: string, base = process.env): NodeJS.ProcessEnv {
	const allowed = new Set([
		"path", "systemroot", "windir", "comspec", "pathext", "lang", "lc_all", "tz",
	]);
	const inherited = Object.fromEntries(
		Object.entries(base).filter(([key]) => allowed.has(key.toLowerCase())),
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
	const tsconfigPath = base.TSX_TSCONFIG_PATH;
	assert.ok(tsconfigPath && path.isAbsolute(tsconfigPath) && existsSync(tsconfigPath),
		"the shared verification runner must provide its selected-SDK tsx alias config");
	return {
		...inherited,
		...trustedTestChildCoverageEnv(base),
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

test("sanitized test children reject ambient options and incomplete or foreign coverage controls", () => {
	const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "pie-trusted-child-env-"));
	try {
		const ambient = {
			PATH: process.env.PATH,
			TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH,
			NODE_OPTIONS: "--require=/untrusted/preload.cjs --inspect=9229",
			NODE_V8_COVERAGE: "/untrusted/raw",
			JITI_SOURCE_MAPS: "false",
			OPENAI_API_KEY: "ambient-secret",
			ANTHROPIC_API_KEY: "ambient-secret",
			OPENAI_BASE_URL: "https://untrusted.example",
		};
		for (const env of [
			buildSanitizedRealChildTestEnv(ambient, fixtureRoot, "inventory"),
			buildSanitizedRealChildTestEnv(ambient, fixtureRoot, "cold-helper"),
			isolatedWorkerEnv(fixtureRoot, path.join(fixtureRoot, "denials"), ambient),
		]) {
			for (const key of ["NODE_OPTIONS", "NODE_V8_COVERAGE", "JITI_SOURCE_MAPS", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_BASE_URL"])
				assert.equal(env[key], undefined, `${key} must not leak`);
			assert.equal(env.PI_OFFLINE, "1");
			assert.equal(env.HOME, path.join(fixtureRoot, "home"));
		}
		const directory = path.join(fixtureRoot, "coverage");
		mkdirSync(path.join(directory, "v8"), { recursive: true, mode: 0o700 });
		const controls = {
			PIE_TEST_COVERAGE_DIR: directory,
			PIE_TEST_COVERAGE_ROOT: repoRoot,
			PIE_TEST_COVERAGE_CWD: repoRoot,
			PIE_TEST_COVERAGE_INCLUDES: "[]",
		};
		for (const key of Object.keys(controls)) {
			assert.deepEqual(trustedTestChildCoverageEnv({ ...controls, [key]: undefined }), {});
		}
		for (const invalid of [
			{ PIE_TEST_COVERAGE_ROOT: fixtureRoot },
			{ PIE_TEST_COVERAGE_DIR: repoRoot },
			{ PIE_TEST_COVERAGE_DIR: path.join(fixtureRoot, "missing") },
			{ PIE_TEST_COVERAGE_CWD: fixtureRoot },
			{ PIE_TEST_COVERAGE_INCLUDES: "not-json" },
			{ PIE_TEST_COVERAGE_INCLUDES: '[42]' },
		]) assert.deepEqual(trustedTestChildCoverageEnv({ ...controls, ...invalid }), {});
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
});

test("trusted covered child captures raw counts with known source provenance", () => {
	const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "pie-trusted-covered-child-"));
	try {
		const directory = path.join(fixtureRoot, "coverage");
		mkdirSync(path.join(directory, "v8"), { recursive: true, mode: 0o700 });
		const source = path.join(repoRoot, "harness/agent-processes/test/fixtures/sanitized-real-child-env.ts");
		const base = {
			...process.env,
			NODE_OPTIONS: "--require=/untrusted/preload.cjs --inspect=9229",
			NODE_V8_COVERAGE: "/untrusted/raw",
			OPENAI_API_KEY: "ambient-secret",
			PIE_TEST_COVERAGE_DIR: directory,
			PIE_TEST_COVERAGE_ROOT: repoRoot,
			PIE_TEST_COVERAGE_CWD: repoRoot,
			PIE_TEST_COVERAGE_INCLUDES: JSON.stringify(["harness/agent-processes/test/fixtures/sanitized-real-child-env.ts"]),
		};
		const env = buildSanitizedRealChildTestEnv(base, fixtureRoot, "cold-helper");
		const workerEnv = isolatedWorkerEnv(fixtureRoot, path.join(fixtureRoot, "denials"), base);
		for (const childEnv of [env, workerEnv]) {
			assert.equal(childEnv.NODE_OPTIONS, `--require=${JSON.stringify(path.join(repoRoot, "scripts/verification/coverage-capture.cjs"))}`);
			assert.equal(childEnv.NODE_V8_COVERAGE, path.join(directory, "v8"));
			assert.equal(childEnv.JITI_SOURCE_MAPS, "true");
			assert.equal(childEnv.OPENAI_API_KEY, undefined);
		}
		const result = spawnSync(process.execPath, [
			"--require", path.join(repoRoot, "node_modules/tsx/dist/cjs/index.cjs"),
			"-e", `const fixture = require(${JSON.stringify(source)}); if (fixture.buildSanitizedRealChildTestEnv(process.env, ${JSON.stringify(fixtureRoot)}, 'cold-helper').PI_OFFLINE !== '1') process.exit(1);`,
		], { cwd: repoRoot, env, encoding: "utf8", timeout: 30_000 });
		assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
		const names = readdirSync(directory);
		assert.ok(!names.some(name => name.startsWith("recorder-error-")));
		const captures = names.filter(name => name.startsWith(`scripts-${result.pid}-`));
		assert.ok(captures.length > 0, "child must have its own recorder evidence");
		const scripts = captures.flatMap(name => JSON.parse(readFileSync(path.join(directory, name), "utf8")).scripts);
		const authored = scripts.find((script: { url: string }) =>
			(script.url.startsWith("file:") ? fileURLToPath(script.url) : script.url) === source);
		assert.ok(authored, "recorder must identify the known fixture source");
		assert.match(authored.code, /buildSanitizedRealChildTestEnv/u);
		const rawNames = readdirSync(path.join(directory, "v8")).filter(name => name.startsWith(`coverage-${result.pid}-`));
		assert.ok(rawNames.length > 0, "child must persist raw V8 counts");
		const rawScripts = rawNames.flatMap(name => JSON.parse(readFileSync(path.join(directory, "v8", name), "utf8")).result);
		assert.ok(rawScripts.some((script: any) => script.url === authored.url
			&& script.scriptId === authored.scriptId
			&& script.functions.some((fn: any) => fn.ranges.some((range: any) => range.count > 0))),
			"raw executed counts must join to the recorder's known source identity");
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
});

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
			// Preserve process isolation while recording this worker separately in
			// the invocation's raw V8/source scope (not the native test merge).
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
