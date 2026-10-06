import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyPiRuntimeArtifact } from '../../../../scripts/lib/pi-runtime-artifact.mjs';

type SourceFixture = typeof import('../../../agent-processes/lib/sdk-integration/test/source-fixture.js');

function writeNetworkDenialPreload(preloadPath: string, denialLogPath: string): void {
  writeFileSync(preloadPath, [
    "const fs = require('node:fs');",
    `const log = ${JSON.stringify(denialLogPath)};`,
    "const deny = (api) => (...args) => { const first = args[0]; const target = first && typeof first === 'object' ? (first.host || first.hostname || first.path) : typeof first === 'string' ? first.slice(0, 120) : typeof first === 'number' ? 'port ' + first : undefined; fs.appendFileSync(log, JSON.stringify({ api, target }) + '\\n'); throw new Error('Network denied by the host runtime fixture: ' + api); };",
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
    "  if (host === undefined) return originalConnect.apply(this, args); // a host-less connect dials the node localhost default",
    "  return deny('net.Socket.connect')(...args);",
    "};",
    "for (const name of ['node:http', 'node:https']) { const api = require(name); for (const method of ['request', 'get']) { const original = api[method]; api[method] = function (input, options, ...rest) { if (localUrl(input, options)) return original.call(this, input, options, ...rest); return deny(name + '.' + method)(input, options, ...rest); }; } }",
    "const tls = require('node:tls'); const originalTlsConnect = tls.connect; tls.connect = function (...args) { const options = args[0]; const host = options && typeof options === 'object' ? options.host || options.hostname : args[1]; if (localHost(host)) return originalTlsConnect.apply(this, args); return deny('tls.connect')(...args); };",
    "const dgram = require('node:dgram'); dgram.createSocket = deny('dgram.createSocket');",
    "const dns = require('node:dns'); for (const name of Object.keys(dns)) if (/^(lookup|resolve|reverse)/.test(name) && typeof dns[name] === 'function') dns[name] = deny('dns.' + name); for (const name of Object.keys(dns.promises)) if (typeof dns.promises[name] === 'function') dns.promises[name] = deny('dns.promises.' + name);",
    "const originalFetch = globalThis.fetch; globalThis.fetch = (input, ...args) => localUrl(input) ? originalFetch(input, ...args) : deny('fetch')(input, ...args);",
    "require('node:module').syncBuiltinESMExports();",
  ].join('\n'), 'utf-8');
}

function isolatedEnvironment(sandbox: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  delete env.NODE_TEST_CONTEXT;
  delete env.PIE_EXTENSION_TOGGLES_JSON;
  for (const name of Object.keys(env)) {
    if (/(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD|_ACCESS_KEY)$/iu.test(name)) delete env[name];
  }
  const profile = path.join(sandbox, 'profile');
  const data = path.join(sandbox, 'data');
  const cache = path.join(sandbox, 'cache');
  const temporary = path.join(sandbox, 'tmp');
  Object.assign(env, {
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: path.join(profile, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    XDG_CONFIG_HOME: path.join(profile, '.config'),
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
    PIE_DATA_ROOT: data,
    PIE_DATA_DIR: data,
    PI_CODING_AGENT_DIR: path.join(sandbox, 'agent'),
    PI_CODING_AGENT_AUTH_DIR: path.join(sandbox, 'auth'),
    PI_CODING_AGENT_SESSION_DIR: path.join(sandbox, 'sessions'),
    PSModulePath: path.join(sandbox, 'ps-modules'),
    PSModuleAnalysisCachePath: path.join(cache, 'powershell', 'module-analysis'),
    POWERSHELL_TELEMETRY_OPTOUT: '1',
    POWERSHELL_UPDATECHECK: 'Off',
    PLAYWRIGHT_BROWSERS_PATH: path.join(cache, 'playwright-browsers'),
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    PUPPETEER_CACHE_DIR: path.join(cache, 'puppeteer'),
    PUPPETEER_SKIP_DOWNLOAD: '1',
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '*',
  });
  return env;
}

test('the verified source Pi runtime discovers the extension and serializes provider-compatible discriminators', { skip: process.env.PLAYWRIGHT_COVERAGE_RUN === '1' }, async (t) => {
  // Fail-closed source gate: a missing or invalid TSX_TSCONFIG_PATH selection
  // makes this direct import throw and the test fails; it must never turn green.
  const shared: SourceFixture = await import('../../../agent-processes/lib/sdk-integration/test/source-fixture.js');
  assert.equal(shared.sourceDescriptor.artifactDir, shared.sourceFixture.piRoot,
    'the shared source fixture graph and its selected descriptor identify the same artifact');
  assert.equal(shared.sourceDescriptor.sdkPath, shared.sourceFixture.packageRoots.codingAgent,
    'the selected descriptor SDK is the coding-agent package in the verified source graph');
  assert.equal(shared.sourceLoadMode.mode, 'source-artifact');
  assert.equal(shared.sourceLoadMode.descriptor, shared.sourceDescriptor);
  // The shared fixture module registers an `after` hook that rehashes the
  // selected candidate after every fixture consumer; the child below receives
  // only the verified selector and independently re-verifies it pre-import.
  const descriptor = shared.sourceDescriptor;

  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(testDir, '..', '..', '..', '..');
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pie-playwright-source-runtime-'));
  const denialLogPath = path.join(sandbox, 'network-denials.jsonl');
  const preloadPath = path.join(sandbox, 'deny-network.cjs');
  writeNetworkDenialPreload(preloadPath, denialLogPath);
  t.after(async () => { await rm(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });

  const child = spawnSync(process.execPath, [
    '--require', preloadPath,
    '--import', 'tsx',
    path.join(testDir, 'fixtures', 'host-runtime-loader.ts'),
    repoRoot,
    JSON.stringify(descriptor),
    sandbox,
    path.join(sandbox, 'result.json'),
  ], {
    cwd: repoRoot,
    env: isolatedEnvironment(sandbox),
    encoding: 'utf8',
    timeout: 90_000,
    windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  // The child also imports node:test through the shared source fixture (its
  // after-hook rehash), so its default runner prints a summary to stdout; the
  // result travels through a sandbox file instead of a fragile stdout parse.
  const result = JSON.parse(await readFile(path.join(sandbox, 'result.json'), 'utf8')) as {
    errors: unknown[]; found: boolean; serializedLength: number; hasConst: boolean;
    actionEnum: string[]; inputKinds: Array<{ type: string; enumLength: number }>;
    artifactDir: string; sdkPath: string; identity: string;
    target: { platform: string; arch: string; nodeAbi: string };
  };
  assert.deepEqual(result.errors, []);
  assert.equal(result.found, true, 'playwright tool was not registered by the selected source Pi loader');
  assert.ok(result.serializedLength > 1000);
  assert.equal(result.hasConst, false, 'string discriminators must use StringEnum rather than Type.Literal');
  assert.deepEqual(result.actionEnum, ['open', 'observe', 'act', 'run_code', 'close']);
  assert.ok(result.inputKinds.length > 0);
  for (const kind of result.inputKinds) {
    assert.equal(kind.type, 'string');
    assert.equal(kind.enumLength, 1);
  }
  assert.equal(result.artifactDir, descriptor.artifactDir);
  assert.equal(result.sdkPath, descriptor.sdkPath);
  assert.equal(result.identity, descriptor.identity);
  assert.deepEqual(result.target, shared.sourceBackendTarget);
  if (existsSync(denialLogPath)) {
    assert.fail(`the child attempted a denied external dial: ${readFileSync(denialLogPath, 'utf-8')}`);
  }
  // Rehash the selected artifact in this process after the child consumed it,
  // mirroring the shared fixture's fail-closed post-consumer after hook.
  const rehashed = await verifyPiRuntimeArtifact(descriptor.artifactDir, { target: shared.sourceBackendTarget });
  assert.equal(rehashed.identity, descriptor.identity);
});