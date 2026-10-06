import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withDevelopmentWriter } from '../../../lib/development-runtime/lifetime.mjs';
import { main, parseArgs, runOfflineVitest } from '../test-framework-offline.mjs';

const PINNED_VITEST = '4.1.9';
const packageNames = {
  ai: '@earendil-works/pi-ai',
  agent: '@earendil-works/pi-agent-core',
  'coding-agent': '@earendil-works/pi-coding-agent',
};

const snapshotNames = [
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'PI_CONFIG_DIR',
  'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_AUTH_DIR', 'PI_CODING_AGENT_SESSION_DIR',
  'PIE_DATA_DIR', 'NODE_OPTIONS', 'NODE_PATH', 'OPENAI_API_KEY',
  'AWS_ACCESS_KEY_ID', 'PI_SDK_PATH', 'PIE_HOST_PROFILE', 'PIE_LIVE_MODEL_ID',
  'NODE_TEST_CONTEXT', 'PI_NO_LOCAL_LLM',
];

const beforeImportSource = `
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
const names = ${JSON.stringify(snapshotNames)};
const snapshot = () => Object.fromEntries(names.map(name => [name, process.env[name]]));
let externalDenied;
try { await fetch('https://external.invalid/'); } catch (error) { externalDenied = error.code; }
const server = createServer((_request, response) => response.end('loopback-ok'));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let loopback;
try {
  const address = server.address();
  loopback = await fetch('http://127.0.0.1:' + address.port).then(response => response.text());
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
appendFileSync(process.env.FRAMEWORK_IMPORT_RECORD, JSON.stringify({ phase: 'module-import', env: snapshot(), externalDenied, loopback }) + '\\n');
`;

const fakeVitestSource = `
import './before-import.mjs';
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const names = ${JSON.stringify(snapshotNames)};
const snapshot = () => Object.fromEntries(names.map(name => [name, process.env[name]]));
appendFileSync(process.env.FRAMEWORK_IMPORT_RECORD, JSON.stringify({ phase: 'cli', argv: process.argv.slice(2), env: snapshot() }) + '\\n');
const childCode = String.raw\`const fs = require('node:fs');
const names = ${JSON.stringify(snapshotNames)};
const env = Object.fromEntries(names.map(name => [name, process.env[name]]));
let externalDenied = false;
if (process.env.NODE_OPTIONS?.includes('vscode-development-stub.cjs')) {
  const http = require('node:http');
  try { http.get('http://external.invalid/'); } catch (error) { externalDenied = error.code === 'PIE_FIXTURE_EXTERNAL_NETWORK_DENIED'; }
}
fs.writeFileSync(process.env.FRAMEWORK_DESCENDANT_RECORD, JSON.stringify({ env, externalDenied }));\`;
const descendant = spawnSync(process.execPath, ['-e', childCode], { encoding: 'utf8' });
if (descendant.error || descendant.status !== 0) {
  console.error(descendant.error?.message ?? descendant.stderr);
  process.exitCode = 1;
}
if (process.argv.includes('--fixture-hang')) setInterval(() => {}, 1000);
const failure = process.argv.find(argument => argument.startsWith('--fixture-exit='));
if (failure) process.exitCode = Number(failure.slice('--fixture-exit='.length));
`;

function makeWorkspace(t, packageName = 'ai') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-framework-fixture-'));
  const workspaceRoot = path.join(root, 'harness', 'pi');
  const codingAgentRoot = path.join(workspaceRoot, 'packages', 'coding-agent');
  const packageRoot = path.join(workspaceRoot, 'packages', packageName);
  const vitestRoot = path.join(packageRoot, 'node_modules', 'vitest');
  mkdirSync(path.join(codingAgentRoot, 'dist'), { recursive: true });
  mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
  mkdirSync(vitestRoot, { recursive: true });
  writeFileSync(path.join(codingAgentRoot, 'package.json'), JSON.stringify({
    name: packageNames['coding-agent'], main: './dist/index.js', type: 'module',
  }));
  writeFileSync(path.join(codingAgentRoot, 'dist', 'index.js'), 'export {}');
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: packageNames[packageName], main: './dist/index.js', type: 'module',
    devDependencies: { vitest: PINNED_VITEST },
  }));
  writeFileSync(path.join(packageRoot, 'dist', 'index.js'), 'export {}');
  writeFileSync(path.join(vitestRoot, 'package.json'), JSON.stringify({
    name: 'vitest', version: PINNED_VITEST, type: 'module', bin: { vitest: './vitest.mjs' },
  }));
  writeFileSync(path.join(vitestRoot, 'vitest.mjs'), fakeVitestSource);
  writeFileSync(path.join(vitestRoot, 'before-import.mjs'), beforeImportSource);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, workspaceRoot, packageRoot };
}

function frameworkEnv(directory) {
  return {
    HOME: path.join(directory, 'real-home'),
    OPENAI_API_KEY: 'must-not-leak',
    AWS_ACCESS_KEY_ID: 'must-not-leak-either',
    PI_SDK_PATH: 'must-not-leak',
    PIE_HOST_PROFILE: 'production',
    PIE_LIVE_MODEL_ID: 'real-live-model',
    NODE_OPTIONS: '--inspect=127.0.0.1:9229',
    NODE_PATH: 'must-not-leak-node-module-path',
    XDG_CACHE_HOME: path.join(directory, 'real-xdg-cache'),
    NODE_TEST_CONTEXT: 'parent-test-context',
    FRAMEWORK_IMPORT_RECORD: path.join(directory, 'import.jsonl'),
    FRAMEWORK_DESCENDANT_RECORD: path.join(directory, 'descendant.json'),
  };
}

function readJsonLines(filePath) {
  return readFileSync(filePath, 'utf8').trim().split(/\r?\n/u).map(line => JSON.parse(line));
}

function readerEntries(workspaceRoot) {
  return readdirSync(path.join(workspaceRoot, '.cache', 'development-runtime', 'readers'));
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${filePath}`);
}

test('the facade selects only Pi ai, agent, or coding-agent and forwards only after --', () => {
  for (const packageName of ['ai', 'agent', 'coding-agent']) {
    assert.deepEqual(parseArgs(['--package', packageName, '--', '--run', 'src/example.test.ts']), {
      packageName,
      vitestArgs: ['--run', 'src/example.test.ts'],
    });
  }
  assert.throws(() => parseArgs(['--package', '../arbitrary', '--']), /Unsupported Pi package/u);
  assert.throws(() => parseArgs(['--package', 'ai', 'src/test.ts']), /Separate Vitest arguments/u);
  assert.deepEqual(parseArgs(['--package', 'ai', '--', '--package', 'agent']), {
    packageName: 'ai',
    vitestArgs: ['--package', 'agent'],
  }, 'arguments after -- are Vitest passthrough, not wrapper selectors');
});

test('private environment and network denial are active before Vitest import and in descendants', async t => {
  const fixture = makeWorkspace(t);
  const sourceEnv = frameworkEnv(fixture.root);
  const code = await runOfflineVitest('ai', ['--fixture-flag', 'two words'], {
    root: fixture.root,
    env: sourceEnv,
  });
  assert.equal(code, 0);
  const [importRecord, cliRecord] = readJsonLines(sourceEnv.FRAMEWORK_IMPORT_RECORD);
  assert.equal(importRecord.phase, 'module-import');
  assert.equal(importRecord.externalDenied, 'PIE_FIXTURE_EXTERNAL_NETWORK_DENIED');
  assert.equal(importRecord.loopback, 'loopback-ok', 'loopback must remain permitted');
  assert.deepEqual(cliRecord.argv, ['--run', '--fixture-flag', 'two words']);

  const profileRoot = path.dirname(importRecord.env.HOME);
  for (const name of [
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'PI_CONFIG_DIR',
    'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_AUTH_DIR', 'PI_CODING_AGENT_SESSION_DIR',
    'PIE_DATA_DIR',
  ]) assert.ok(isWithin(profileRoot, importRecord.env[name]), `${name} must be private`);
  for (const name of ['OPENAI_API_KEY', 'AWS_ACCESS_KEY_ID', 'PI_SDK_PATH', 'PIE_HOST_PROFILE', 'PIE_LIVE_MODEL_ID', 'NODE_TEST_CONTEXT', 'NODE_PATH', 'XDG_CACHE_HOME']) {
    assert.equal(importRecord.env[name], undefined, `${name} must be removed before import`);
  }
  assert.match(importRecord.env.NODE_OPTIONS, /vscode-development-stub\.cjs/u);
  assert.equal(cliRecord.env.NODE_OPTIONS, importRecord.env.NODE_OPTIONS);
  assert.equal(importRecord.env.PI_NO_LOCAL_LLM, '1', 'offline invocation disables automatic local-model startup and downloads');

  const descendant = JSON.parse(readFileSync(sourceEnv.FRAMEWORK_DESCENDANT_RECORD, 'utf8'));
  assert.equal(descendant.externalDenied, true, 'the invocation-only preload must reach Node descendants');
  assert.equal(descendant.env.NODE_OPTIONS, importRecord.env.NODE_OPTIONS);
  assert.equal(descendant.env.PI_CODING_AGENT_AUTH_DIR, importRecord.env.PI_CODING_AGENT_AUTH_DIR);
  assert.equal(existsSync(profileRoot), false, 'confirmed completion removes the private profile');
  assert.deepEqual(readerEntries(fixture.workspaceRoot), [], 'confirmed completion releases the workspace reader');
  await withDevelopmentWriter(path.join(fixture.workspaceRoot), async () => {});
});

test('ordinary Vitest failures preserve their code and still clean profile and reader', async t => {
  const fixture = makeWorkspace(t);
  const sourceEnv = frameworkEnv(fixture.root);
  const code = await runOfflineVitest('ai', ['--fixture-exit=7'], { root: fixture.root, env: sourceEnv });
  assert.equal(code, 7);
  const records = readJsonLines(sourceEnv.FRAMEWORK_IMPORT_RECORD);
  const profileRoot = path.dirname(records[0].env.HOME);
  assert.equal(existsSync(profileRoot), false);
  assert.deepEqual(readerEntries(fixture.workspaceRoot), []);
});

test('unconfirmed descendant teardown returns reserved 125 and retains profile plus reader', async t => {
  const fixture = makeWorkspace(t);
  const sourceEnv = frameworkEnv(fixture.root);
  let childOptions;
  const spawnImpl = (_command, _args, options) => {
    childOptions = options;
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };
  const dependencies = {
    root: fixture.root,
    env: sourceEnv,
    spawnImpl,
    watchChildProcessImpl: () => ({
      timedOut: false,
      aborted: false,
      settle: async () => ({ gone: false, survivors: [4242], diagnostics: ['fixture survivor'] }),
    }),
  };
  const exitCode = await main(['--package', 'ai', '--', '--run'], {
    abortOnProcessSignals: () => ({ signal: undefined, dispose() {} }),
    runOptions: dependencies,
  });
  assert.equal(exitCode, 125);
  const profileRoot = path.dirname(childOptions.env.HOME);
  t.after(() => rmSync(profileRoot, { recursive: true, force: true }));
  assert.equal(existsSync(profileRoot), true);
  assert.equal(readerEntries(fixture.workspaceRoot).length, 1);
  await assert.rejects(withDevelopmentWriter(fixture.workspaceRoot, async () => {}), /writer denied[\s\S]*reader/u);
});

test('cancellation tears down the child under the same reader lifetime and cleans confirmed state', async t => {
  const fixture = makeWorkspace(t);
  const sourceEnv = frameworkEnv(fixture.root);
  const controller = new AbortController();
  const running = runOfflineVitest('ai', ['--fixture-hang'], {
    root: fixture.root,
    env: sourceEnv,
    signal: controller.signal,
    timeoutMs: 10_000,
  });
  await waitForFile(sourceEnv.FRAMEWORK_IMPORT_RECORD);
  assert.equal(readerEntries(fixture.workspaceRoot).length, 1, 'reader remains registered throughout the child lifetime');
  controller.abort(new Error('fixture cancellation'));
  assert.equal(await running, 1);
  const records = readJsonLines(sourceEnv.FRAMEWORK_IMPORT_RECORD);
  const profileRoot = path.dirname(records[0].env.HOME);
  assert.equal(existsSync(profileRoot), false);
  assert.deepEqual(readerEntries(fixture.workspaceRoot), []);
  await withDevelopmentWriter(fixture.workspaceRoot, async () => {});
});
